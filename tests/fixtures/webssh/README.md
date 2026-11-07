# WebSSH test fixtures

These keys are **throwaway, non-production test fixtures** generated with the system
`ssh-keygen`. They protect nothing: the private halves are committed on purpose so the
OpenSSH key-format tests can run without invoking `ssh-keygen` themselves. They are safe
to commit and must never be reused anywhere else.

Generated with:

```
ssh-keygen -q -t ed25519 -f tests/fixtures/webssh/throwaway-ed25519     -N ''              -C 'throwaway ed25519 (unencrypted, test only)'
ssh-keygen -q -t ed25519 -f tests/fixtures/webssh/throwaway-ed25519-enc -N 'w3-passphrase' -C 'throwaway ed25519 (encrypted, test only)'
ssh-keygen -q -t rsa -b 2048 -f tests/fixtures/webssh/throwaway-rsa-enc -N 'w3-passphrase' -C 'throwaway rsa 2048 (encrypted, test only)'
```

The `.pub` files are the public halves produced alongside, kept so the fingerprints in
`tests/webssh-key-format.test.ts` can be checked with `ssh-keygen -lf`. The two encrypted
keys use the passphrase `w3-passphrase`.
