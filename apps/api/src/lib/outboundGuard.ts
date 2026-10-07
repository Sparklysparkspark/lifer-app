// Outbound requests to an address a user typed (migrating the desktop library to a server). Loopback,
// link-local (which includes cloud metadata services, 169.254.169.254) and unspecified addresses are
// refused; private LAN addresses stay allowed, since a home server is the normal target.
//
// The check runs on the socket that was actually connected, not on the hostname text: after DNS,
// after redirects, and for IP literals alike. So a name that resolves to a public address when it's
// checked and to 127.0.0.1 when it's used (DNS rebinding) is still refused, before any request
// bytes are sent. assertAllowedTarget is the early check, for a clear error message up front.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector } from "undici";

const refused = new BlockList();
refused.addSubnet("0.0.0.0", 8, "ipv4");
refused.addSubnet("127.0.0.0", 8, "ipv4");
refused.addSubnet("169.254.0.0", 16, "ipv4");
refused.addAddress("::", "ipv6");
refused.addAddress("::1", "ipv6");
refused.addSubnet("fe80::", 10, "ipv6");
// AWS's IPv6 metadata address, which sits in the otherwise-allowed unique-local range.
refused.addAddress("fd00:ec2::254", "ipv6");

export class RefusedAddressError extends Error {
  constructor(readonly address: string) {
    super(`Refusing to connect to ${address}: loopback and link-local addresses aren't allowed as a server address`);
    this.name = "RefusedAddressError";
  }
}

/** Loopback, link-local, unspecified or a cloud metadata address (IPv4, IPv6, or IPv4-mapped IPv6). */
export function isRefusedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return refused.check(mapped[1], "ipv4");
  const family = isIP(bare);
  if (family === 4) return refused.check(bare, "ipv4");
  if (family === 6) return refused.check(bare, "ipv6");
  // Not an IP address: never connectable as one, so refuse rather than guess.
  return true;
}

type LookupAll = (hostname: string) => Promise<Array<{ address: string }>>;
const lookupAll: LookupAll = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Throws RefusedAddressError when the URL's host is, or resolves to, a refused address. Every
 *  address it resolves to must be allowed, since the connection may use any of them. */
export async function assertAllowedTarget(url: URL, resolve: LookupAll = lookupAll): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await resolve(host)).map((a) => a.address);
  const bad = addresses.find(isRefusedAddress);
  if (bad) throw new RefusedAddressError(bad);
}

/** An undici dispatcher for fetch() that refuses any connection whose peer is a refused address.
 *  `lookup` replaces DNS resolution, for tests. */
export function guardedDispatcher(
  opts: { lookup?: (hostname: string, options: object, callback: (...args: never[]) => void) => void } = {},
): Agent {
  const base = buildConnector(opts.lookup ? ({ lookup: opts.lookup } as buildConnector.BuildOptions) : {});
  const connect: buildConnector.connector = (options, callback) =>
    base(options, (err, socket) => {
      if (err || !socket) return callback(err ?? new Error("Connection failed"), null);
      const peer = socket.remoteAddress ?? "";
      if (isRefusedAddress(peer)) {
        socket.destroy();
        return callback(new RefusedAddressError(peer || options.hostname), null);
      }
      callback(null, socket);
    });
  return new Agent({ connect });
}

/** fetch() init for a request through `dispatcher`. Node's fetch takes undici's dispatcher option,
 *  which the DOM RequestInit type doesn't declare. */
export function viaDispatcher(dispatcher: Agent | undefined): RequestInit {
  return dispatcher ? ({ dispatcher } as unknown as RequestInit) : {};
}
