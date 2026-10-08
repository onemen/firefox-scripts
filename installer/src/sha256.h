#ifndef SHA256_H
#define SHA256_H

#include <stddef.h>

/*
 * Minimal FIPS 180-4 SHA-256, inlined into the installer: the previous
 * implementation shelled out to certutil/sha256sum per
 * hash, making a security primitive depend on the output format of an
 * external tool and costing a process spawn per package per browser on the
 * single-threaded serve loop.  Parity with the JS reference
 * (tools/publish/hashUtils.mjs) is enforced by installer/test/test_hash.mjs
 * (pnpm test:hash) — the C and JS digests must agree byte-for-byte.
 */

#define SHA256_DIGEST_SIZE 32 /* bytes; 64 lowercase hex chars + NUL when formatted */

/** Incremental SHA-256 state. */
typedef struct {
    unsigned int state[8];
    unsigned long long bitlen;
    unsigned char block[64];
    size_t block_used;
} Sha256Ctx;

/** Initialize a context. */
void sha256_init(Sha256Ctx *ctx);

/** Feed len bytes into the hash. */
void sha256_update(Sha256Ctx *ctx, const unsigned char *data, size_t len);

/** Finalize: writes 32 raw bytes to out (out may alias nothing in ctx). */
void sha256_final(Sha256Ctx *ctx, unsigned char out[SHA256_DIGEST_SIZE]);

/** One-shot helper over a buffer. */
void sha256(const unsigned char *data, size_t len, unsigned char out[SHA256_DIGEST_SIZE]);

/** Format a raw digest as 64 lowercase hex chars + NUL (out needs >= 65). */
void sha256_hex(const unsigned char digest[SHA256_DIGEST_SIZE], char *out, size_t out_size);

#endif /* SHA256_H */
