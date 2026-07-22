# Security

Do not commit or publish:

- local companion `config.json` files or API tokens;
- SQLite databases or cached chapter bodies;
- SSH private keys or `known_hosts` files;
- novel source text, ZIP exports, reports, or downloaded release artifacts;
- machine-specific installation paths.

The companion API must remain bound to `127.0.0.1`. Verify the SSH server fingerprint out of band before accepting a host key. If a token or private key is exposed, rotate it before continuing.
