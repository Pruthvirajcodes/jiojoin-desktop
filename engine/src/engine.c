/*
 * JioJoin Desktop engine: a headless PJSUA process driven by the Electron
 * main process over newline-delimited JSON.
 *
 *   stdin   one JSON command per line   {"id":1,"cmd":"hello"}
 *   stdout  one JSON message per line   {"id":1,"ok":true,...} or {"event":...}
 *   stderr  human-readable log lines    "<level> <text>"
 *
 * Secrets arrive only on stdin (never argv or the environment), and SIP
 * message logging stays off so logs never carry credentials.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <pjsua-lib/pjsua.h>
#include <pjlib-util/json.h>

#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#  include <io.h>
#  define dup _dup
#  define dup2 _dup2
#  define fdopen _fdopen
#else
#  include <unistd.h>
#endif

#include "jsonout.h"

#define ENGINE_VERSION "1.0.0"
#define PROTOCOL_VERSION 1
#define USER_AGENT "JioJoinDesktop/" ENGINE_VERSION " JUICEJSE/1.4.3"
#define CLOCK_RATE 16000
#define EC_TAIL_MS 200
#define SAMPLES_PER_FRAME (CLOCK_RATE / 50)
#define MAX_LINE 16384

/* IMS feature tags JUICE expects on the Contact of an MMTel voice client. */
#define FEATURE_TAGS                                                       \
    ";+g.3gpp.icsi-ref=\"urn%3Aurn-7%3A3gpp-service.ims.icsi.mmtel\""      \
    ";+g.3gpp.iari-ref=\"urn%3Aurn-7%3A3gpp-application.ims.iari.rcs.jio.eucr\""

static struct engine {
    pj_pool_t *pool;
    pj_mutex_t *out_mutex;
    FILE *out;

    pjsua_transport_id tls;
    pjsua_acc_id acc;
    char pani[160];
    char preferred_identity[320];
    char tls_name[160];

    pjsua_call_id call;
    pj_bool_t dialing;
    char remote_number[96];
    char remote_name[128];

    pjmedia_port *ring_port, *ringback_port, *test_port, *null_port;
    pjsua_conf_port_id ring_slot, ringback_slot, test_slot, null_slot;
    pj_bool_t ring_on, ringback_on, meter_on, muted;

    char input_name[PJMEDIA_AUD_DEV_INFO_NAME_LEN];
    char output_name[PJMEDIA_AUD_DEV_INFO_NAME_LEN];
} g;

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

static void emit(jb *b)
{
    const char *line = jb_end(b);
    if (g.out_mutex) pj_mutex_lock(g.out_mutex);
    fputs(line, g.out);
    fputc('\n', g.out);
    fflush(g.out);
    if (g.out_mutex) pj_mutex_unlock(g.out_mutex);
}

static void log_cb(int level, const char *data, int len)
{
    while (len > 0 && (data[len - 1] == '\n' || data[len - 1] == '\r')) len--;
    fprintf(stderr, "%d %.*s\n", level, len, data);
    fflush(stderr);
}

static void logf_(int level, const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    log_cb(level, buf, (int)strlen(buf));
}

static const char *errstr(pj_status_t status, char *buf, size_t size)
{
    pj_strerror(status, buf, size);
    return buf;
}

static void reply_begin(jb *b, int id, pj_bool_t ok)
{
    jb_init(b);
    jb_int(b, "id", id);
    jb_bool(b, "ok", ok);
}

static void reply_simple(int id)
{
    jb b;
    reply_begin(&b, id, PJ_TRUE);
    emit(&b);
}

static void reply_error(int id, const char *message)
{
    jb b;
    reply_begin(&b, id, PJ_FALSE);
    jb_str(&b, "error", message, -1);
    emit(&b);
}

static void reply_status(int id, const char *what, pj_status_t status)
{
    char err[160], msg[256];
    snprintf(msg, sizeof(msg), "%s: %s", what, errstr(status, err, sizeof(err)));
    reply_error(id, msg);
}

/* ------------------------------------------------------------------ */
/* JSON input helpers                                                 */
/* ------------------------------------------------------------------ */

static pj_json_elem *jfind(pj_json_elem *obj, const char *name)
{
    pj_json_elem *child;
    if (!obj || obj->type != PJ_JSON_VAL_OBJ) return NULL;
    child = obj->value.children.next;
    while (child != (pj_json_elem *)&obj->value.children) {
        if (pj_strcmp2(&child->name, name) == 0) return child;
        child = child->next;
    }
    return NULL;
}

static pj_str_t jstr(pj_json_elem *obj, const char *name)
{
    pj_json_elem *el = jfind(obj, name);
    pj_str_t empty = {NULL, 0};
    if (el && el->type == PJ_JSON_VAL_STRING) return el->value.str;
    return empty;
}

static int jint(pj_json_elem *obj, const char *name, int fallback)
{
    pj_json_elem *el = jfind(obj, name);
    if (el && el->type == PJ_JSON_VAL_NUMBER) return (int)el->value.num;
    return fallback;
}

static pj_bool_t jbool(pj_json_elem *obj, const char *name, pj_bool_t fallback)
{
    pj_json_elem *el = jfind(obj, name);
    if (el && el->type == PJ_JSON_VAL_BOOL) return el->value.is_true;
    return fallback;
}

static void copy_str(char *dst, size_t size, const pj_str_t *src)
{
    size_t n = (size_t)src->slen < size - 1 ? (size_t)src->slen : size - 1;
    if (src->slen > 0) memcpy(dst, src->ptr, n);
    else n = 0;
    dst[n] = '\0';
}

/* ------------------------------------------------------------------ */
/* P-Access-Network-Info on every request                             */
/* ------------------------------------------------------------------ */

static pj_status_t pani_on_tx_request(pjsip_tx_data *tdata)
{
    static const pj_str_t NAME = {"P-Access-Network-Info", 21};

    /* Retransmissions and auth retries reuse the tdata, so add it once. */
    if (g.pani[0] && !pjsip_msg_find_hdr_by_name(tdata->msg, &NAME, NULL)) {
        pj_str_t value = pj_str(g.pani);
        pjsip_msg_add_hdr(tdata->msg,
                          (pjsip_hdr *)pjsip_generic_string_hdr_create(
                              tdata->pool, &NAME, &value));
    }
    return PJ_SUCCESS;
}

/* Runs before the transport layer prints the message into its buffer. */
static pjsip_module mod_pani = {
    NULL, NULL,
    {"mod-jio-pani", 12},
    -1,
    PJSIP_MOD_PRIORITY_TRANSPORT_LAYER + 1,
    NULL, NULL, NULL, NULL,
    NULL, NULL,
    &pani_on_tx_request,
    NULL,
    NULL,
};

/* ------------------------------------------------------------------ */
/* Tones                                                              */
/* ------------------------------------------------------------------ */

static void tone_create(const char *name, pjmedia_port **port,
                        pjsua_conf_port_id *slot)
{
    pj_str_t label = pj_str((char *)name);
    *slot = PJSUA_INVALID_ID;
    if (pjmedia_tonegen_create2(g.pool, &label, CLOCK_RATE, 1,
                                SAMPLES_PER_FRAME, 16, 0, port) != PJ_SUCCESS)
    {
        *port = NULL;
        return;
    }
    pjsua_conf_add_port(g.pool, *port, slot);
}

static void tone_start(pjmedia_port *port, pjsua_conf_port_id slot,
                       const pjmedia_tone_desc *tones, unsigned count,
                       pj_bool_t loop)
{
    if (!port || slot == PJSUA_INVALID_ID) return;
    pjmedia_tonegen_stop(port);
    pjmedia_tonegen_play(port, count, tones, loop ? PJMEDIA_TONEGEN_LOOP : 0);
    pjsua_conf_connect(slot, 0);
}

static void tone_stop(pjmedia_port *port, pjsua_conf_port_id slot)
{
    if (!port || slot == PJSUA_INVALID_ID) return;
    pjsua_conf_disconnect(slot, 0);
    pjmedia_tonegen_stop(port);
}

static void ring_start(void)
{
    /* A soft three-note chime, repeated every 2.6 s. */
    static const pjmedia_tone_desc tones[] = {
        {659, 0, 170, 40, 9000, 0},
        {831, 0, 170, 40, 9000, 0},
        {988, 0, 380, 1800, 9000, 0},
    };
    if (g.ring_on) return;
    g.ring_on = PJ_TRUE;
    tone_start(g.ring_port, g.ring_slot, tones, PJ_ARRAY_SIZE(tones), PJ_TRUE);
}

static void ring_stop(void)
{
    if (!g.ring_on) return;
    g.ring_on = PJ_FALSE;
    tone_stop(g.ring_port, g.ring_slot);
}

static void ringback_start(void)
{
    /* Indian ringing tone: 400 Hz modulated at 25 Hz, 0.4 on / 0.2 off /
     * 0.4 on / 2.0 off. 375 Hz + 425 Hz is that modulation exactly. */
    static const pjmedia_tone_desc tones[] = {
        {375, 425, 400, 200, 6000, 0},
        {375, 425, 400, 2000, 6000, 0},
    };
    if (g.ringback_on) return;
    g.ringback_on = PJ_TRUE;
    tone_start(g.ringback_port, g.ringback_slot, tones, PJ_ARRAY_SIZE(tones),
               PJ_TRUE);
}

static void ringback_stop(void)
{
    if (!g.ringback_on) return;
    g.ringback_on = PJ_FALSE;
    tone_stop(g.ringback_port, g.ringback_slot);
}

static void test_tone_done(void *user_data)
{
    PJ_UNUSED_ARG(user_data);
    tone_stop(g.test_port, g.test_slot);
}

/* ------------------------------------------------------------------ */
/* Audio devices                                                      */
/* ------------------------------------------------------------------ */

static int find_device(const char *name, pj_bool_t input)
{
    pjmedia_aud_dev_info info[64];
    unsigned i, count = PJ_ARRAY_SIZE(info);

    if (!name[0] || pjsua_enum_aud_devs(info, &count) != PJ_SUCCESS)
        return input ? PJMEDIA_AUD_DEFAULT_CAPTURE_DEV
                     : PJMEDIA_AUD_DEFAULT_PLAYBACK_DEV;
    for (i = 0; i < count; i++) {
        unsigned channels = input ? info[i].input_count : info[i].output_count;
        if (channels > 0 && strcmp(info[i].name, name) == 0) return (int)i;
    }
    return input ? PJMEDIA_AUD_DEFAULT_CAPTURE_DEV
                 : PJMEDIA_AUD_DEFAULT_PLAYBACK_DEV;
}

static pj_status_t apply_devices(void)
{
    pjsua_snd_dev_param prm;

    if (getenv("JIOJOIN_ENGINE_NULL_AUDIO")) return PJ_SUCCESS;
    /* macOS's VoiceProcessingIO cancels echo well but always uses the system
     * default devices, ignoring the ones asked for. Keep it only when the
     * user hasn't picked a device; otherwise cancel echo in software. */
    pjsua_set_ec(EC_TAIL_MS, (g.input_name[0] || g.output_name[0]) ? PJMEDIA_ECHO_USE_SW_ECHO : 0);
    pjsua_snd_dev_param_default(&prm);
    prm.capture_dev = find_device(g.input_name, PJ_TRUE);
    prm.playback_dev = find_device(g.output_name, PJ_FALSE);
    /* Keep the microphone closed until a call or the level meter needs it. */
    prm.mode = pjsua_snd_is_active() ? 0 : PJSUA_SND_DEV_NO_IMMEDIATE_OPEN;
    return pjsua_set_snd_dev2(&prm);
}

static void meter_tick(void *user_data)
{
    unsigned tx = 0, rx = 0;
    jb b;
    PJ_UNUSED_ARG(user_data);
    if (!g.meter_on) return;
    pjsua_conf_get_signal_level(0, &tx, &rx);
    jb_init(&b);
    jb_str(&b, "event", "level", -1);
    jb_int(&b, "mic", (long)rx);
    jb_int(&b, "speaker", (long)tx);
    emit(&b);
    pjsua_schedule_timer2(&meter_tick, NULL, 80);
}

/* ------------------------------------------------------------------ */
/* Calls                                                              */
/* ------------------------------------------------------------------ */

/* Splits a From / P-Asserted-Identity value into number and display name. */
static void parse_party(const pj_str_t *value, char *number, size_t number_size,
                        char *name, size_t name_size)
{
    pj_pool_t *pool;
    pj_str_t copy;
    pjsip_uri *uri;

    number[0] = name[0] = '\0';
    if (value->slen <= 0) return;

    pool = pjsua_pool_create("party", 1024, 1024);
    pj_strdup_with_null(pool, &copy, value);
    uri = pjsip_parse_uri(pool, copy.ptr, copy.slen, PJSIP_PARSE_URI_AS_NAMEADDR);
    if (uri) {
        pjsip_name_addr *na = (pjsip_name_addr *)uri;
        pjsip_uri *inner = (pjsip_uri *)pjsip_uri_get_uri(uri);
        if (PJSIP_URI_SCHEME_IS_SIP(uri) || PJSIP_URI_SCHEME_IS_SIPS(uri)) {
            copy_str(number, number_size, &((pjsip_sip_uri *)inner)->user);
        } else if (PJSIP_URI_SCHEME_IS_TEL(uri)) {
            copy_str(number, number_size, &((pjsip_tel_uri *)inner)->number);
        }
        copy_str(name, name_size, &na->display);
    }
    pj_pool_release(pool);
}

static const char *call_state_name(const pjsua_call_info *ci)
{
    switch (ci->state) {
    case PJSIP_INV_STATE_CALLING: return "calling";
    case PJSIP_INV_STATE_INCOMING: return "incoming";
    case PJSIP_INV_STATE_EARLY:
        return ci->role == PJSIP_ROLE_UAC ? "ringing" : "incoming";
    case PJSIP_INV_STATE_CONNECTING: return "connecting";
    case PJSIP_INV_STATE_CONFIRMED: return "active";
    case PJSIP_INV_STATE_DISCONNECTED: return "ended";
    default: return "calling";
    }
}

static pjsua_call_media_status audio_status(const pjsua_call_info *ci,
                                            pjsua_conf_port_id *slot)
{
    unsigned i;
    for (i = 0; i < ci->media_cnt; i++) {
        if (ci->media[i].type == PJMEDIA_TYPE_AUDIO) {
            if (slot) *slot = ci->media[i].stream.aud.conf_slot;
            return ci->media[i].status;
        }
    }
    if (slot) *slot = PJSUA_INVALID_ID;
    return PJSUA_CALL_MEDIA_NONE;
}

static void emit_call(pjsua_call_id call_id, const pjsua_call_info *ci)
{
    jb b;
    pjsua_call_media_status media = audio_status(ci, NULL);

    jb_init(&b);
    jb_str(&b, "event", "call", -1);
    jb_int(&b, "callId", call_id);
    jb_str(&b, "direction", ci->role == PJSIP_ROLE_UAC ? "out" : "in", -1);
    jb_str(&b, "state", call_state_name(ci), -1);
    jb_str(&b, "number", g.remote_number, -1);
    jb_str(&b, "name", g.remote_name, -1);
    jb_int(&b, "code", ci->last_status);
    jb_str(&b, "reason", ci->last_status_text.ptr, (int)ci->last_status_text.slen);
    jb_bool(&b, "held", media == PJSUA_CALL_MEDIA_LOCAL_HOLD);
    jb_bool(&b, "remoteHeld", media == PJSUA_CALL_MEDIA_REMOTE_HOLD);
    jb_bool(&b, "muted", g.muted);
    if (media == PJSUA_CALL_MEDIA_ACTIVE) {
        pjsua_stream_info si;
        if (pjsua_call_get_stream_info(call_id, 0, &si) == PJ_SUCCESS &&
            si.type == PJMEDIA_TYPE_AUDIO)
        {
            jb_str(&b, "codec", si.info.aud.fmt.encoding_name.ptr,
                   (int)si.info.aud.fmt.encoding_name.slen);
        }
    }
    emit(&b);
}

static void set_muted(pj_bool_t muted)
{
    g.muted = muted;
    pjsua_conf_adjust_rx_level(0, muted ? 0.0f : 1.0f);
}

static void on_incoming_call(pjsua_acc_id acc_id, pjsua_call_id call_id,
                             pjsip_rx_data *rdata)
{
    static const pj_str_t PAI = {"P-Asserted-Identity", 19};
    pjsua_call_info ci;
    pjsip_generic_string_hdr *pai;
    char number[sizeof(g.remote_number)], name[sizeof(g.remote_name)];

    PJ_UNUSED_ARG(acc_id);
    if (pjsua_call_get_info(call_id, &ci) != PJ_SUCCESS) return;

    /* IMS puts the trusted caller identity in P-Asserted-Identity. */
    pai = (pjsip_generic_string_hdr *)pjsip_msg_find_hdr_by_name(
        rdata->msg_info.msg, &PAI, NULL);
    if (pai) parse_party(&pai->hvalue, number, sizeof(number), name, sizeof(name));
    else number[0] = name[0] = '\0';
    if (!number[0])
        parse_party(&ci.remote_info, number, sizeof(number), name, sizeof(name));

    if (g.call != PJSUA_INVALID_ID) {
        jb b;
        pjsua_call_answer(call_id, 486, NULL, NULL);
        jb_init(&b);
        jb_str(&b, "event", "busyReject", -1);
        jb_str(&b, "number", number, -1);
        jb_str(&b, "name", name, -1);
        emit(&b);
        return;
    }

    g.call = call_id;
    snprintf(g.remote_number, sizeof(g.remote_number), "%s", number);
    snprintf(g.remote_name, sizeof(g.remote_name), "%s", name);
    emit_call(call_id, &ci);
    pjsua_call_answer(call_id, 180, NULL, NULL);
    ring_start();
}

static void on_call_state(pjsua_call_id call_id, pjsip_event *e)
{
    pjsua_call_info ci;

    PJ_UNUSED_ARG(e);
    /* The first state change of an outgoing call arrives inside
     * pjsua_call_make_call(), before it has returned the call id. */
    if (g.call == PJSUA_INVALID_ID && g.dialing) g.call = call_id;
    if (call_id != g.call || pjsua_call_get_info(call_id, &ci) != PJ_SUCCESS)
        return;

    switch (ci.state) {
    case PJSIP_INV_STATE_EARLY:
        /* 180 without early media: play ringback locally. */
        if (ci.role == PJSIP_ROLE_UAC && ci.last_status == 180 &&
            audio_status(&ci, NULL) != PJSUA_CALL_MEDIA_ACTIVE)
        {
            ringback_start();
        }
        break;
    case PJSIP_INV_STATE_CONNECTING:
    case PJSIP_INV_STATE_CONFIRMED:
        ring_stop();
        ringback_stop();
        break;
    case PJSIP_INV_STATE_DISCONNECTED:
        ring_stop();
        ringback_stop();
        break;
    default:
        break;
    }

    emit_call(call_id, &ci);

    if (ci.state == PJSIP_INV_STATE_DISCONNECTED) {
        g.call = PJSUA_INVALID_ID;
        g.remote_number[0] = g.remote_name[0] = '\0';
        set_muted(PJ_FALSE);
    }
}

static void on_call_media_state(pjsua_call_id call_id)
{
    pjsua_call_info ci;
    pjsua_conf_port_id slot;
    pjsua_call_media_status status;

    if (call_id != g.call || pjsua_call_get_info(call_id, &ci) != PJ_SUCCESS)
        return;

    status = audio_status(&ci, &slot);
    if ((status == PJSUA_CALL_MEDIA_ACTIVE ||
         status == PJSUA_CALL_MEDIA_REMOTE_HOLD) && slot != PJSUA_INVALID_ID)
    {
        ringback_stop();
        pjsua_conf_connect(slot, 0);
        pjsua_conf_connect(0, slot);
    }
    emit_call(call_id, &ci);
}

/* ------------------------------------------------------------------ */
/* Registration and transport                                         */
/* ------------------------------------------------------------------ */

static void emit_reg(const char *state, int code, const char *reason,
                     int reason_len, unsigned expires)
{
    jb b;
    jb_init(&b);
    jb_str(&b, "event", "reg", -1);
    jb_str(&b, "state", state, -1);
    jb_int(&b, "code", code);
    jb_str(&b, "reason", reason, reason_len);
    jb_int(&b, "expires", (long)expires);
    emit(&b);
}

static void on_reg_started2(pjsua_acc_id acc_id, pjsua_reg_info *info)
{
    PJ_UNUSED_ARG(info);
    if (acc_id == g.acc) emit_reg("registering", 0, "", 0, 0);
}

static void on_reg_state2(pjsua_acc_id acc_id, pjsua_reg_info *info)
{
    struct pjsip_regc_cbparam *p = info->cbparam;
    char err[160];

    if (acc_id != g.acc || !p) return;
    if (p->status != PJ_SUCCESS) {
        errstr(p->status, err, sizeof(err));
        emit_reg("failed", p->code, err, -1, 0);
    } else if (p->code / 100 == 2) {
        if (p->expiration < 1)
            emit_reg("unregistered", p->code, p->reason.ptr, (int)p->reason.slen, 0);
        else
            emit_reg("registered", p->code, p->reason.ptr, (int)p->reason.slen,
                     p->expiration);
    } else {
        emit_reg("failed", p->code, p->reason.ptr, (int)p->reason.slen, 0);
    }
}

static void on_transport_state(pjsip_transport *tp, pjsip_transport_state state,
                               const pjsip_transport_state_info *info)
{
    jb b;
    char err[160];
    pj_bool_t is_tls = (tp->flag & PJSIP_TRANSPORT_SECURE) != 0;

    if (!is_tls || tp->dir != PJSIP_TP_DIR_OUTGOING) return;

    if (state == PJSIP_TP_STATE_CONNECTED) {
        /* Chain verification is off because the router's certificate is
         * self-signed. Still insist it names the router, so the exception
         * covers that one certificate identity and nothing else. */
        const pjsip_tls_state_info *tls = (const pjsip_tls_state_info *)info->ext_info;
        const pj_ssl_cert_info *cert =
            (tls && tls->ssl_sock_info) ? tls->ssl_sock_info->remote_cert_info : NULL;
        if (g.tls_name[0] &&
            (!cert || pj_stricmp2(&cert->subject.cn, g.tls_name) != 0))
        {
            logf_(1, "TLS certificate does not name the router; closing");
            pjsip_transport_shutdown(tp);
            jb_init(&b);
            jb_str(&b, "event", "transport", -1);
            jb_str(&b, "state", "rejected", -1);
            jb_str(&b, "reason", "certificate-name-mismatch", -1);
            emit(&b);
            return;
        }
        jb_init(&b);
        jb_str(&b, "event", "transport", -1);
        jb_str(&b, "state", "connected", -1);
        emit(&b);
    } else if (state == PJSIP_TP_STATE_DISCONNECTED) {
        jb_init(&b);
        jb_str(&b, "event", "transport", -1);
        jb_str(&b, "state", "disconnected", -1);
        jb_str(&b, "reason", errstr(info->status, err, sizeof(err)), -1);
        emit(&b);
    }
}

static void teardown_account(void)
{
    if (g.acc != PJSUA_INVALID_ID) {
        pjsua_call_hangup_all();
        pjsua_acc_del(g.acc);
        g.acc = PJSUA_INVALID_ID;
    }
    if (g.tls != PJSUA_INVALID_ID) {
        pjsua_transport_close(g.tls, PJ_FALSE);
        g.tls = PJSUA_INVALID_ID;
    }
    g.pani[0] = '\0';
}

static void cmd_register(int id, pj_json_elem *a, pj_pool_t *pool)
{
    pjsua_transport_config tcfg;
    pjsua_acc_config cfg;
    pj_status_t status;
    pj_str_t proxy = jstr(a, "proxy");
    pj_str_t registrar = jstr(a, "registrar");
    pj_str_t identity = jstr(a, "identity");
    pj_str_t auth_user = jstr(a, "authUser");
    pj_str_t auth_realm = jstr(a, "authRealm");
    pj_str_t password = jstr(a, "password");
    pj_str_t instance = jstr(a, "instanceId");
    pj_str_t pani = jstr(a, "pani");
    pj_str_t local = jstr(a, "localAddress");
    pj_str_t tls_name = jstr(a, "tlsName");
    char *buf;
    int len;

    if (!proxy.slen || !registrar.slen || !identity.slen || !auth_user.slen ||
        !password.slen || !instance.slen)
    {
        reply_error(id, "register: missing required field");
        return;
    }
    teardown_account();
    copy_str(g.pani, sizeof(g.pani), &pani);
    copy_str(g.tls_name, sizeof(g.tls_name), &tls_name);
    len = snprintf(g.preferred_identity, sizeof(g.preferred_identity), "<%.*s>",
                   (int)identity.slen, identity.ptr);
    if (len < 0 || len >= (int)sizeof(g.preferred_identity))
        g.preferred_identity[0] = '\0';

    pjsua_transport_config_default(&tcfg);
    tcfg.port = 0;
    if (local.slen) {
        pj_strdup_with_null(pool, &tcfg.bound_addr, &local);
        pj_strdup_with_null(pool, &tcfg.public_addr, &local);
    }
    tcfg.tls_setting.verify_server = PJ_FALSE;
    tcfg.tls_setting.verify_client = PJ_FALSE;
    status = pjsua_transport_create(PJSIP_TRANSPORT_TLS, &tcfg, &g.tls);
    if (status != PJ_SUCCESS) {
        g.tls = PJSUA_INVALID_ID;
        reply_status(id, "TLS transport", status);
        return;
    }

    pjsua_acc_config_default(&cfg);
    pj_strdup_with_null(pool, &cfg.id, &identity);
    pj_strdup_with_null(pool, &cfg.reg_uri, &registrar);
    cfg.proxy_cnt = 1;
    pj_strdup_with_null(pool, &cfg.proxy[0], &proxy);

    cfg.cred_count = 1;
    if (auth_realm.slen) pj_strdup_with_null(pool, &cfg.cred_info[0].realm, &auth_realm);
    else cfg.cred_info[0].realm = pj_str("*");
    cfg.cred_info[0].scheme = pj_str("digest");
    pj_strdup_with_null(pool, &cfg.cred_info[0].username, &auth_user);
    cfg.cred_info[0].data_type = PJSIP_CRED_DATA_PLAIN_PASSWD;
    pj_strdup_with_null(pool, &cfg.cred_info[0].data, &password);

    /* RFC 5626 with Jio's bare-UUID instance id. The instance parameter is
     * also part of contact_params so INVITE and 200 OK Contacts carry it;
     * see patches/pjproject-2.17-jio.patch. */
    cfg.use_rfc5626 = PJ_TRUE;
    buf = (char *)pj_pool_alloc(pool, instance.slen + 3);
    len = snprintf(buf, instance.slen + 3, "<%.*s>", (int)instance.slen, instance.ptr);
    pj_strset(&cfg.rfc5626_instance_id, buf, len);
    buf = (char *)pj_pool_alloc(pool, instance.slen + sizeof(FEATURE_TAGS) + 32);
    len = snprintf(buf, instance.slen + sizeof(FEATURE_TAGS) + 32,
                   ";+sip.instance=\"<%.*s>\"%s",
                   (int)instance.slen, instance.ptr, FEATURE_TAGS);
    pj_strset(&cfg.contact_params, buf, len);

    cfg.transport_id = g.tls;
    cfg.reg_timeout = (unsigned)jint(a, "expires", 3600);
    /* Retries are the main process's job: it must refresh credentials from
     * the router before every new attempt. */
    cfg.reg_retry_interval = 0;
    cfg.reg_first_retry_interval = 0;
    cfg.drop_calls_on_reg_fail = PJ_FALSE;
    cfg.allow_contact_rewrite = PJ_FALSE;
    cfg.allow_via_rewrite = PJ_FALSE;
    cfg.allow_sdp_nat_rewrite = PJ_FALSE;
    cfg.sip_stun_use = PJSUA_STUN_USE_DISABLED;
    cfg.media_stun_use = PJSUA_STUN_USE_DISABLED;
    cfg.mwi_enabled = PJ_FALSE;
    cfg.publish_enabled = PJ_FALSE;
    cfg.use_srtp = PJMEDIA_SRTP_DISABLED;

    cfg.rtp_cfg.port = (unsigned)jint(a, "rtpPort", 52000);
    cfg.rtp_cfg.port_range = 200;
    if (local.slen) {
        pj_strdup_with_null(pool, &cfg.rtp_cfg.bound_addr, &local);
        pj_strdup_with_null(pool, &cfg.rtp_cfg.public_addr, &local);
    }

    status = pjsua_acc_add(&cfg, PJ_TRUE, &g.acc);
    /* Do not keep the password in this short-lived pool longer than needed. */
    pj_bzero(cfg.cred_info[0].data.ptr, cfg.cred_info[0].data.slen);
    if (status != PJ_SUCCESS) {
        g.acc = PJSUA_INVALID_ID;
        teardown_account();
        reply_status(id, "account", status);
        return;
    }
    reply_simple(id);
}

/* ------------------------------------------------------------------ */
/* Commands                                                           */
/* ------------------------------------------------------------------ */

static void cmd_hello(int id)
{
    pjsua_codec_info codecs[32];
    unsigned i, count = PJ_ARRAY_SIZE(codecs);
    pj_ssl_cipher ciphers[PJ_SSL_SOCK_MAX_CIPHERS];
    unsigned cipher_count = PJ_ARRAY_SIZE(ciphers);
    pj_bool_t tls = PJ_FALSE;
    jb b;

#if PJSIP_HAS_TLS_TRANSPORT
    tls = pj_ssl_cipher_get_availables(ciphers, &cipher_count) == PJ_SUCCESS &&
          cipher_count > 0;
#endif
    reply_begin(&b, id, PJ_TRUE);
    jb_str(&b, "engine", ENGINE_VERSION, -1);
    jb_int(&b, "protocol", PROTOCOL_VERSION);
    jb_str(&b, "pjsip", pj_get_version(), -1);
    jb_bool(&b, "tls", tls);
    jb_open(&b, "codecs", '[');
    if (pjsua_enum_codecs(codecs, &count) == PJ_SUCCESS) {
        for (i = 0; i < count; i++) {
            if (codecs[i].priority == 0) continue;
            jb_str(&b, NULL, codecs[i].codec_id.ptr, (int)codecs[i].codec_id.slen);
        }
    }
    jb_close(&b, ']');
    emit(&b);
}

static void cmd_dial(int id, pj_json_elem *a, pj_pool_t *pool)
{
    pj_str_t uri_in = jstr(a, "uri"), number = jstr(a, "number");
    pj_str_t uri;
    pjsua_call_setting opt;
    pjsua_msg_data msg;
    pjsip_generic_string_hdr ppi;
    pj_str_t ppi_name = pj_str("P-Preferred-Identity");
    pj_str_t ppi_value;
    pjsua_call_id call_id = PJSUA_INVALID_ID;
    pj_status_t status;
    jb b;

    if (g.acc == PJSUA_INVALID_ID) { reply_error(id, "not registered"); return; }
    if (g.call != PJSUA_INVALID_ID) { reply_error(id, "a call is already in progress"); return; }
    pj_strdup_with_null(pool, &uri, &uri_in);
    if (!uri.slen || pjsua_verify_sip_url(uri.ptr) != PJ_SUCCESS) {
        reply_error(id, "invalid number");
        return;
    }

    pjsua_call_setting_default(&opt);
    opt.aud_cnt = 1;
    opt.vid_cnt = 0;
    pjsua_msg_data_init(&msg);
    if (g.preferred_identity[0]) {
        ppi_value = pj_str(g.preferred_identity);
        pjsip_generic_string_hdr_init2(&ppi, &ppi_name, &ppi_value);
        pj_list_push_back(&msg.hdr_list, &ppi);
    }

    copy_str(g.remote_number, sizeof(g.remote_number), &number);
    g.remote_name[0] = '\0';
    g.dialing = PJ_TRUE;
    status = pjsua_call_make_call(g.acc, &uri, &opt, NULL, &msg, &call_id);
    g.dialing = PJ_FALSE;
    if (status != PJ_SUCCESS) {
        g.call = PJSUA_INVALID_ID;
        reply_status(id, "call", status);
        return;
    }
    if (pjsua_call_is_active(call_id)) g.call = call_id;
    reply_begin(&b, id, PJ_TRUE);
    jb_int(&b, "callId", call_id);
    emit(&b);
}

static void cmd_devices(int id)
{
    pjmedia_aud_dev_info info[64];
    unsigned i, count = PJ_ARRAY_SIZE(info);
    jb b;

    /* Pick up hot-plugged devices, but never while audio is flowing. */
    if (!pjsua_snd_is_active() && !g.meter_on) {
        pjmedia_aud_dev_refresh();
        apply_devices();
    }
    if (pjsua_enum_aud_devs(info, &count) != PJ_SUCCESS) count = 0;

    reply_begin(&b, id, PJ_TRUE);
    jb_open(&b, "devices", '[');
    for (i = 0; i < count; i++) {
        jb_open(&b, NULL, '{');
        jb_str(&b, "name", info[i].name, -1);
        jb_int(&b, "inputs", (long)info[i].input_count);
        jb_int(&b, "outputs", (long)info[i].output_count);
        jb_close(&b, '}');
    }
    jb_close(&b, ']');
    jb_str(&b, "input", g.input_name, -1);
    jb_str(&b, "output", g.output_name, -1);
    emit(&b);
}

static void cmd_set_devices(int id, pj_json_elem *a)
{
    pj_status_t status;
    if (jfind(a, "input")) {
        pj_str_t v = jstr(a, "input");
        copy_str(g.input_name, sizeof(g.input_name), &v);
    }
    if (jfind(a, "output")) {
        pj_str_t v = jstr(a, "output");
        copy_str(g.output_name, sizeof(g.output_name), &v);
    }
    status = apply_devices();
    if (status != PJ_SUCCESS) reply_status(id, "audio device", status);
    else reply_simple(id);
}

static void cmd_meter(int id, pj_json_elem *a)
{
    pj_bool_t on = jbool(a, "on", PJ_FALSE);
    if (on && !g.meter_on && g.null_slot != PJSUA_INVALID_ID) {
        pj_status_t status = pjsua_conf_connect(0, g.null_slot);
        if (status != PJ_SUCCESS) { reply_status(id, "microphone", status); return; }
        g.meter_on = PJ_TRUE;
        pjsua_schedule_timer2(&meter_tick, NULL, 80);
    } else if (!on && g.meter_on) {
        g.meter_on = PJ_FALSE;
        pjsua_conf_disconnect(0, g.null_slot);
    }
    reply_simple(id);
}

static void cmd_test_tone(int id)
{
    static const pjmedia_tone_desc tones[] = {
        {523, 0, 220, 30, 9000, 0},
        {659, 0, 220, 30, 9000, 0},
        {784, 0, 360, 100, 9000, 0},
    };
    if (!g.test_port) { reply_error(id, "tone generator unavailable"); return; }
    tone_start(g.test_port, g.test_slot, tones, PJ_ARRAY_SIZE(tones), PJ_FALSE);
    pjsua_schedule_timer2(&test_tone_done, NULL, 1200);
    reply_simple(id);
}

static pj_bool_t require_call(int id, pj_json_elem *a)
{
    int call_id = jint(a, "callId", g.call);
    if (g.call == PJSUA_INVALID_ID || call_id != g.call) {
        reply_error(id, "no such call");
        return PJ_FALSE;
    }
    return PJ_TRUE;
}

/* Returns PJ_TRUE when the engine should shut down. */
static pj_bool_t handle_command(char *line, unsigned len)
{
    pj_pool_t *pool = pjsua_pool_create("cmd", 4096, 4096);
    pj_json_err_info err;
    pj_json_elem *root = pj_json_parse(pool, line, &len, &err);
    pj_str_t cmd;
    pj_status_t status = PJ_SUCCESS;
    pj_bool_t quit = PJ_FALSE;
    int id;

    if (!root || root->type != PJ_JSON_VAL_OBJ) {
        reply_error(0, "malformed JSON");
        pj_pool_release(pool);
        return PJ_FALSE;
    }
    id = jint(root, "id", 0);
    cmd = jstr(root, "cmd");

    if (pj_strcmp2(&cmd, "hello") == 0) {
        cmd_hello(id);
    } else if (pj_strcmp2(&cmd, "register") == 0) {
        cmd_register(id, root, pool);
    } else if (pj_strcmp2(&cmd, "unregister") == 0) {
        /* Keep the account so the un-REGISTER can answer its auth challenge;
         * on_reg_state2 reports the result. */
        if (g.acc != PJSUA_INVALID_ID) {
            pjsua_call_hangup_all();
            pjsua_acc_set_registration(g.acc, PJ_FALSE);
        }
        reply_simple(id);
    } else if (pj_strcmp2(&cmd, "dial") == 0) {
        cmd_dial(id, root, pool);
    } else if (pj_strcmp2(&cmd, "answer") == 0) {
        if (require_call(id, root)) {
            ring_stop();
            status = pjsua_call_answer(g.call, 200, NULL, NULL);
            if (status != PJ_SUCCESS) reply_status(id, "answer", status);
            else reply_simple(id);
        }
    } else if (pj_strcmp2(&cmd, "hangup") == 0) {
        if (require_call(id, root)) {
            ring_stop();
            ringback_stop();
            status = pjsua_call_hangup(g.call, 0, NULL, NULL);
            if (status != PJ_SUCCESS) reply_status(id, "hangup", status);
            else reply_simple(id);
        }
    } else if (pj_strcmp2(&cmd, "hold") == 0) {
        if (require_call(id, root)) {
            if (jbool(root, "on", PJ_TRUE))
                status = pjsua_call_set_hold(g.call, NULL);
            else
                status = pjsua_call_reinvite(g.call, PJSUA_CALL_UNHOLD, NULL);
            if (status != PJ_SUCCESS) reply_status(id, "hold", status);
            else reply_simple(id);
        }
    } else if (pj_strcmp2(&cmd, "mute") == 0) {
        set_muted(jbool(root, "on", PJ_TRUE));
        reply_simple(id);
    } else if (pj_strcmp2(&cmd, "dtmf") == 0) {
        if (require_call(id, root)) {
            pj_str_t digits = jstr(root, "digits");
            status = pjsua_call_dial_dtmf(g.call, &digits);
            if (status != PJ_SUCCESS) reply_status(id, "dtmf", status);
            else reply_simple(id);
        }
    } else if (pj_strcmp2(&cmd, "devices") == 0) {
        cmd_devices(id);
    } else if (pj_strcmp2(&cmd, "setDevices") == 0) {
        cmd_set_devices(id, root);
    } else if (pj_strcmp2(&cmd, "meter") == 0) {
        cmd_meter(id, root);
    } else if (pj_strcmp2(&cmd, "testTone") == 0) {
        cmd_test_tone(id);
    } else if (pj_strcmp2(&cmd, "quit") == 0) {
        reply_simple(id);
        quit = PJ_TRUE;
    } else {
        reply_error(id, "unknown command");
    }
    pj_pool_release(pool);
    return quit;
}

/* ------------------------------------------------------------------ */
/* Startup                                                            */
/* ------------------------------------------------------------------ */

static void set_amr_fmtp(const char *codec, const char *mode_set)
{
    pj_str_t id = pj_str((char *)codec);
    pjmedia_codec_param param;

    if (pjsua_codec_get_param(&id, &param) != PJ_SUCCESS) return;
    param.setting.dec_fmtp.cnt = 2;
    param.setting.dec_fmtp.param[0].name = pj_str("octet-align");
    param.setting.dec_fmtp.param[0].val = pj_str("1");
    param.setting.dec_fmtp.param[1].name = pj_str("mode-set");
    param.setting.dec_fmtp.param[1].val = pj_str((char *)mode_set);
    param.setting.vad = 0;
    pjsua_codec_set_param(&id, &param);
}

static void setup_codecs(void)
{
    pjsua_codec_info codecs[32];
    unsigned i, count = PJ_ARRAY_SIZE(codecs);
    pj_str_t id;

    if (pjsua_enum_codecs(codecs, &count) == PJ_SUCCESS)
        for (i = 0; i < count; i++)
            pjsua_codec_set_priority(&codecs[i].codec_id, 0);

    pjsua_codec_set_priority(pj_cstr(&id, "AMR-WB/16000"), 255);
    pjsua_codec_set_priority(pj_cstr(&id, "AMR/8000"), 254);
    pjsua_codec_set_priority(pj_cstr(&id, "PCMU/8000"), 253);
    set_amr_fmtp("AMR-WB/16000", "0,1,2,3,4,5,6,7,8");
    set_amr_fmtp("AMR/8000", "0,1,2,3,4,5,6,7");
}

static pj_status_t engine_start(void)
{
    pjsua_config cfg;
    pjsua_logging_config log_cfg;
    pjsua_media_config media_cfg;
    pj_status_t status;

    status = pjsua_create();
    if (status != PJ_SUCCESS) return status;

    g.pool = pjsua_pool_create("engine", 4096, 4096);
    pj_mutex_create_recursive(g.pool, "out", &g.out_mutex);

    pjsua_config_default(&cfg);
    cfg.max_calls = 4;
    cfg.thread_cnt = 1;
    cfg.user_agent = pj_str(USER_AGENT);
    cfg.use_srtp = PJMEDIA_SRTP_DISABLED;
    cfg.cb.on_incoming_call = &on_incoming_call;
    cfg.cb.on_call_state = &on_call_state;
    cfg.cb.on_call_media_state = &on_call_media_state;
    cfg.cb.on_reg_started2 = &on_reg_started2;
    cfg.cb.on_reg_state2 = &on_reg_state2;
    cfg.cb.on_transport_state = &on_transport_state;

    pjsua_logging_config_default(&log_cfg);
    log_cfg.msg_logging = PJ_FALSE;
    log_cfg.level = getenv("JIOJOIN_ENGINE_VERBOSE") ? 4 : 3;
    log_cfg.console_level = log_cfg.level;
    log_cfg.decor = PJ_LOG_HAS_SENDER;
    log_cfg.cb = &log_cb;

    pjsua_media_config_default(&media_cfg);
    media_cfg.clock_rate = CLOCK_RATE;
    media_cfg.snd_clock_rate = 0;
    media_cfg.channel_count = 1;
    media_cfg.no_vad = PJ_TRUE;
    media_cfg.ec_tail_len = EC_TAIL_MS;
    media_cfg.snd_auto_close_time = 1;
    media_cfg.enable_ice = PJ_FALSE;

    status = pjsua_init(&cfg, &log_cfg, &media_cfg);
    if (status != PJ_SUCCESS) return status;

    status = pjsip_endpt_register_module(pjsua_get_pjsip_endpt(), &mod_pani);
    if (status != PJ_SUCCESS) return status;

    status = pjsua_start();
    if (status != PJ_SUCCESS) return status;

    setup_codecs();
    tone_create("ring", &g.ring_port, &g.ring_slot);
    tone_create("ringback", &g.ringback_port, &g.ringback_slot);
    tone_create("test", &g.test_port, &g.test_slot);
    g.null_slot = PJSUA_INVALID_ID;
    if (pjmedia_null_port_create(g.pool, CLOCK_RATE, 1, SAMPLES_PER_FRAME, 16,
                                 &g.null_port) == PJ_SUCCESS)
    {
        pjsua_conf_add_port(g.pool, g.null_port, &g.null_slot);
    }
    /* Tests and headless machines run without touching real audio hardware. */
    if (getenv("JIOJOIN_ENGINE_NULL_AUDIO")) pjsua_set_null_snd_dev();
    else apply_devices();
    return PJ_SUCCESS;
}

int main(int argc, char **argv)
{
    static char line[MAX_LINE];
    pj_status_t status;
    char err[160];
    jb b;
    int out_fd;

    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
        printf("jiojoin-engine %s (protocol %d)\n", ENGINE_VERSION, PROTOCOL_VERSION);
        return 0;
    }

    /* Reserve the real stdout for protocol messages; anything a library
     * prints to stdout goes to stderr instead. */
    fflush(stdout);
    out_fd = dup(1);
    g.out = out_fd >= 0 ? fdopen(out_fd, "w") : NULL;
    if (!g.out) return 2;
    dup2(2, 1);
#ifndef _WIN32
    signal(SIGPIPE, SIG_IGN);
#endif

    g.acc = PJSUA_INVALID_ID;
    g.tls = PJSUA_INVALID_ID;
    g.call = PJSUA_INVALID_ID;
    pj_log_set_log_func(&log_cb);
    pj_log_set_level(3);

    status = engine_start();
    if (status != PJ_SUCCESS) {
        jb_init(&b);
        jb_str(&b, "event", "fatal", -1);
        jb_str(&b, "error", errstr(status, err, sizeof(err)), -1);
        emit(&b);
        return 1;
    }

    jb_init(&b);
    jb_str(&b, "event", "ready", -1);
    jb_int(&b, "protocol", PROTOCOL_VERSION);
    jb_str(&b, "engine", ENGINE_VERSION, -1);
    emit(&b);

    /* stdin closing means the parent went away: shut down cleanly so the
     * registration is removed and no orphan keeps the microphone. */
    while (fgets(line, sizeof(line), stdin)) {
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r'))
            line[--len] = '\0';
        if (len == 0) continue;
        if (handle_command(line, (unsigned)len)) break;
    }

    g.meter_on = PJ_FALSE;
    pjsua_call_hangup_all();
    pjsua_destroy();
    return 0;
}
