# Security policy

## Supported versions

Lifer is in beta. Security fixes go into the latest release only, so please update before
reporting, and stay on the newest version.

| Version         | Supported |
| --------------- | --------- |
| Latest release  | Yes       |
| Anything older  | No        |

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue or discussion:

1. Go to [Report a vulnerability](https://github.com/Sparklysparkspark/lifer-app/security/advisories/new)
   (the Security tab, then "Report a vulnerability").
2. Describe the problem, the affected version and install type (desktop app, Docker, TrueNAS),
   and how to reproduce it. A proof of concept helps, but leave real photos and personal data out.

You should hear back within a week. Once a fix is ready it ships in a release, and the advisory
is published with credit to you, unless you'd rather stay anonymous.

## Scope

In scope: the Lifer server and web app, the desktop app, the Docker image and the files in this
repository.

Out of scope: a server you've exposed to the internet without the HTTPS reverse proxy the docs
describe, issues in third-party services Lifer downloads data from, and denial of service
through very large uploads on a server you run yourself (see `MAX_UPLOAD_BYTES`).
