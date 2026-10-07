---
title: Reverse proxy and HTTPS
description: Reach Lifer at your own domain with HTTPS, using Nginx Proxy Manager, Caddy, nginx or Traefik.
---

# Reverse proxy and HTTPS

A reverse proxy gives Lifer a domain name and HTTPS, like `https://lifer.example.com`. Lifer needs very little from it: the proxy just forwards requests to Lifer's port.

On a home network with no domain, you can skip this page and use `http://<server-ip>:4000`.

## Setup

1. In your proxy, forward your domain to `http://<server-ip>:4000` (or the port you set with `PORT`).
2. Tell Lifer which address the proxy connects from, with `TRUST_PROXY` in `.env` (see [below](#trust-proxy)), then run `docker compose up -d`.
3. Open Lifer at your domain.

Lifer sees that you reached it over HTTPS and keeps your sign-in HTTPS only.

A few things you don't need to worry about:

- **Upload size.** Photos and videos of any size go up in small, resumable pieces, so you don't need to raise your proxy's upload limit. See [Large uploads](#large-uploads).
- **Websockets.** Lifer doesn't use them.
- **Headers.** The proxies below pass along everything Lifer needs by default. You only tell Lifer which proxy to believe ([below](#trust-proxy)).

Lifer must be served at the root of a domain or subdomain (`lifer.example.com`), not under a path like `example.com/lifer`.

## Tell Lifer about your proxy {#trust-proxy}

Lifer limits failed sign-ins per visitor address. Behind a proxy, every request comes from the proxy, so Lifer needs to know it can believe the visitor's real address the proxy passes along (`X-Forwarded-For`). It believes no one by default, because a device on your network could otherwise claim any address it likes. Without `TRUST_PROXY`, everything still works, but the sign-in limit is shared by all visitors, and Lifer's log says so the first time a request comes through the proxy: look for `TRUST_PROXY isn't set`. That line also shows the address the proxy connects from.

Set `TRUST_PROXY` in `.env` to that address:

| Your setup | Set |
|---|---|
| The proxy runs on another computer, like Nginx Proxy Manager on a separate box | Its IP address: `TRUST_PROXY=192.168.1.5` |
| The proxy runs on the same server, in Docker or installed directly (Nginx Proxy Manager, Caddy, nginx, Traefik, `cloudflared`) | Docker's private networks: `TRUST_PROXY=172.16.0.0/12`. Connections from other devices on your network keep their own addresses, so they can't pretend. If the log line shows an address outside that range, or your home network itself uses `172.16.x.x` to `172.31.x.x` addresses, use the exact address from the log line instead. |
| Lifer runs without Docker, with the proxy on the same machine | `TRUST_PROXY=loopback` |
| Two proxies in a row, like Cloudflare in front of nginx | `TRUST_PROXY=2`, the number of proxies, but only if Lifer's port can't be reached without going through them. |

Several values can be combined with commas, like `TRUST_PROXY=192.168.1.5,172.16.0.0/12`.

:::note Upgrading
Lifer used to trust any proxy on a private network by default. If you use a reverse proxy and never set `TRUST_PROXY`, add it as above. Setting `TRUST_PROXY=loopback,linklocal,uniquelocal` brings back the old behavior exactly, including its weakness on a shared network.
:::

## Examples

### Nginx Proxy Manager

1. Click **Add Proxy Host**.
2. **Domain Names:** `lifer.example.com`. **Scheme:** `http`. **Forward Hostname / IP:** your server's IP address. **Forward Port:** `4000`.
3. On the **SSL** tab, choose **Request a new SSL Certificate** and turn on **Force SSL**.
4. Click **Save**.

### Caddy

Caddy gets and renews the certificate for you:

```text
lifer.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name lifer.example.com;

    ssl_certificate     /etc/letsencrypt/live/lifer.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lifer.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name lifer.example.com;
    return 301 https://$host$request_uri;
}
```

### Traefik

Add these labels to the `api` service in `docker-compose.yml`, adjusting the entry point and certificate resolver names to match your Traefik setup:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.lifer.rule=Host(`lifer.example.com`)"
  - "traefik.http.routers.lifer.entrypoints=websecure"
  - "traefik.http.routers.lifer.tls.certresolver=letsencrypt"
  - "traefik.http.services.lifer.loadbalancer.server.port=4000"
```

### Cloudflare Tunnel

Point the tunnel's public hostname at `http://<server-ip>:4000`. Cloudflare handles HTTPS.

## Large uploads {#large-uploads}

The Lifer web app and desktop app send files in pieces that start at 8 MB. If a proxy turns a piece away as too large, Lifer automatically tries again with smaller pieces, and an interrupted upload picks up where it left off. So Nginx Proxy Manager's, nginx's and Cloudflare's default size limits all work without changes.

Only scripts that upload with a single plain multipart request (instead of [resumable uploads](../api/overview.md#large-files)) are limited by the proxy. For those, raise the limit in nginx with `client_max_body_size 0;`.

## Unusual setups {#advanced}

- **Two proxies in a row**, like Cloudflare in front of nginx: see [Tell Lifer about your proxy](#trust-proxy).

See [Environment variables](./environment-variables.md#security-and-reverse-proxies) for details.

If the desktop app connects to this server, it can use the fast local address at home and your domain elsewhere. See [Automatic URL switching](./connect-desktop-to-server.md#url-switching).
