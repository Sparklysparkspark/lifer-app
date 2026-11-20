import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import CodeBlock from "@theme/CodeBlock";
import { Callout, Hero, Section } from "../site-kit/components";
import { chownCommand, upCommand } from "../data/selfHostingCommands";

export default function SelfHosting() {
  return (
    <Layout title="Self-hosting" description="Run Lifer on a NAS or home server with Docker, and use it from any browser.">
      <Hero title="Run Lifer on your own server" lede="Keep your archive on a NAS or an always-on computer and open it from any device on your network." />
      <Section title="Desktop or server?">
        <table>
          <thead>
            <tr><th>Desktop app</th><th>Server</th></tr>
          </thead>
          <tbody>
            <tr><td>One computer, nothing to set up.</td><td>One home for the archive, reached from any device.</td></tr>
            <tr><td>Runs when you open it.</td><td>Always on, so imports keep going.</td></tr>
            <tr><td><Link to="/download">Download</Link></td><td>Docker, on Linux, a NAS or TrueNAS.</td></tr>
          </tbody>
        </table>
      </Section>
      <Section title="Docker quick start" muted>
        <p>Make a folder for your photos and one for Lifer, then give Lifer's user access to them:</p>
        <CodeBlock language="bash">{chownCommand}</CodeBlock>
        <p>Save the compose file from the <Link to="/install/docker">Docker guide</Link>, then start Lifer from its folder:</p>
        <CodeBlock language="bash">{upCommand}</CodeBlock>
        <p>Open the server's address on port 4000 in a browser and make your account. The guide covers every step.</p>
      </Section>
      <Section title="TrueNAS and other NAS apps">
        <p>On TrueNAS, install Lifer as a custom app from the same compose file. Portainer, Synology Container Manager and Unraid work the same way. See <Link to="/install/docker">Install with Docker</Link>.</p>
      </Section>
      <Section title="Next steps" muted>
        <ul>
          <li><Link to="/install/reverse-proxy">Reverse proxy</Link>, to reach Lifer with a web address and HTTPS.</li>
          <li><Link to="/install/hardware-acceleration">GPU acceleration</Link>, for faster species recognition.</li>
          <li><Link to="/install/backup-restore">Backup and restore</Link>.</li>
          <li><Link to="/install/connect-desktop-to-server">Connect the desktop app to your server</Link>.</li>
        </ul>
        <Callout>
          On your phone, open the server's address in the browser. There is no separate mobile app.
        </Callout>
      </Section>
    </Layout>
  );
}
