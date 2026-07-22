# Pull release artifacts over SSH/SFTP and expose only a localhost API

The Windows companion executes or observes the server exporter, reads the remote manifest, and downloads only chapter versions absent from its local SQLite cache over SSH/SFTP. It exposes the resulting queue to the Chrome extension on `127.0.0.1`; no WebDAV, Samba share, public manuscript API, or always-running server API is required.
