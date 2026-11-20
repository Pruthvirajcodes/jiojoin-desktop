/*
 * Minimal JSON line writer for engine output. Fixed buffer, no allocation,
 * safe to use from PJSIP callbacks.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef JIOJOIN_JSONOUT_H
#define JIOJOIN_JSONOUT_H

#include <stdio.h>
#include <string.h>

typedef struct jb {
    char buf[16384];
    size_t len;
    int need_comma;
} jb;

static void jb_putc(jb *b, char c)
{
    /* Leave room for the closing brace and terminator. */
    if (b->len < sizeof(b->buf) - 8) b->buf[b->len++] = c;
}

static void jb_puts(jb *b, const char *s)
{
    while (*s) jb_putc(b, *s++);
}

static void jb_quote(jb *b, const char *s, int len)
{
    int i;
    if (len < 0) len = s ? (int)strlen(s) : 0;
    jb_putc(b, '"');
    for (i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"' || c == '\\') {
            jb_putc(b, '\\');
            jb_putc(b, (char)c);
        } else if (c < 0x20) {
            char esc[8];
            snprintf(esc, sizeof(esc), "\\u%04x", c);
            jb_puts(b, esc);
        } else {
            jb_putc(b, (char)c);
        }
    }
    jb_putc(b, '"');
}

static void jb_key(jb *b, const char *key)
{
    if (b->need_comma) jb_putc(b, ',');
    b->need_comma = 1;
    if (key) {
        jb_quote(b, key, -1);
        jb_putc(b, ':');
    }
}

static void jb_init(jb *b)
{
    b->len = 0;
    b->need_comma = 0;
    jb_putc(b, '{');
}

static void jb_str(jb *b, const char *key, const char *value, int len)
{
    jb_key(b, key);
    jb_quote(b, value, len);
}

static void jb_int(jb *b, const char *key, long value)
{
    char num[32];
    jb_key(b, key);
    snprintf(num, sizeof(num), "%ld", value);
    jb_puts(b, num);
}

static void jb_bool(jb *b, const char *key, int value)
{
    jb_key(b, key);
    jb_puts(b, value ? "true" : "false");
}

/* Opens a nested array ('[') or object ('{'); key is NULL inside arrays. */
static void jb_open(jb *b, const char *key, char bracket)
{
    jb_key(b, key);
    jb_putc(b, bracket);
    b->need_comma = 0;
}

static void jb_close(jb *b, char bracket)
{
    jb_putc(b, bracket);
    b->need_comma = 1;
}

static const char *jb_end(jb *b)
{
    b->buf[b->len++] = '}';
    b->buf[b->len] = '\0';
    return b->buf;
}

#endif
