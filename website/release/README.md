# Published releases

The Forgejo release workflow writes one immutable directory per tag at `release/vVERSION-BUILD/`. Each directory contains Linux and macOS packages, checksums, `metadata.json`, and its detached Ed25519 signature.

Published directories and tags stay immutable. Correct a broken release with a new version and build number.

