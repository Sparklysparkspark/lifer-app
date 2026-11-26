import type { ReactNode } from "react";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import styles from "./kit.module.css";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export function ButtonLink({
  href,
  variant = "primary",
  children,
}: {
  href: string;
  variant?: "primary" | "secondary";
  children: ReactNode;
}) {
  return (
    <Link className={cx(styles.button, styles[variant])} href={href}>
      {children}
    </Link>
  );
}

/** The page's single h1. */
export function Hero({
  eyebrow,
  title,
  lede,
  actions,
  media,
}: {
  /** A short line above the title, such as the product's name. */
  eyebrow?: string;
  title: string;
  lede?: string;
  actions?: ReactNode;
  media?: ReactNode;
}) {
  return (
    <header className={styles.hero}>
      <div className={styles.heroText}>
        {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
        <h1>{title}</h1>
        {lede && <p className={styles.lede}>{lede}</p>}
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {media}
    </header>
  );
}

export function Section({
  title,
  intro,
  muted,
  children,
}: {
  title: string;
  intro?: string;
  muted?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={cx(styles.section, muted && styles.sectionMuted)}>
      <div className={styles.sectionInner}>
        <h2>{title}</h2>
        {intro && <p className={styles.intro}>{intro}</p>}
        {children}
      </div>
    </section>
  );
}

export interface Shot {
  src: string;
  width: number;
  height: number;
  /** Optional AVIF or WebP candidates, as a srcset string. */
  srcSet?: string;
}

/** A light and a dark screenshot; CSS shows the one for the current theme. */
export function ScreenshotFrame({
  alt,
  light,
  dark,
  caption,
  priority,
}: {
  alt: string;
  light: Shot;
  dark?: Shot;
  caption?: string;
  priority?: boolean;
}) {
  const base = useBaseUrl("/");
  const url = (p: string) => (p.startsWith("/") ? base + p.slice(1) : p);
  const img = (s: Shot, cls: string, lazy: boolean) => (
    <img
      className={cls}
      src={url(s.src)}
      srcSet={s.srcSet}
      sizes="(min-width: 997px) 55vw, 100vw"
      width={s.width}
      height={s.height}
      alt={alt}
      loading={lazy ? "lazy" : "eager"}
      decoding="async"
    />
  );
  return (
    <figure className={styles.frame}>
      {img(light, dark ? styles.onlyLight : "", !priority)}
      {dark && img(dark, styles.onlyDark, true)}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

export function FeatureRow({
  title,
  children,
  shot,
  reverse,
}: {
  title: string;
  children: ReactNode;
  shot?: ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className={cx(styles.feature, reverse && styles.featureReverse)}>
      <div className={styles.featureText}>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
      {shot}
    </div>
  );
}

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}

export type Platform = "mac" | "windows" | "linux";

export function DownloadCard({
  platform,
  title,
  note,
  links,
}: {
  platform: Platform;
  title: string;
  note?: string;
  links: { label: string; href: string; primary?: boolean }[];
}) {
  return (
    <div className={styles.card} data-platform={platform}>
      <h3>{title}</h3>
      {note && <p>{note}</p>}
      <div className={styles.cardActions}>
        {links.map((l) => (
          <ButtonLink key={l.href} href={l.href} variant={l.primary ? "primary" : "secondary"}>
            {l.label}
          </ButtonLink>
        ))}
      </div>
    </div>
  );
}

// Sets data-detected on <html>; CSS moves the matching card first. No request, no storage.
const detect = `(function(){var p=(navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||"";var d=/mac/i.test(p)?"mac":/win/i.test(p)?"windows":/linux|x11/i.test(p)?"linux":"";if(d)document.documentElement.setAttribute("data-detected",d)})()`;

/** Download cards; without JavaScript they all show in source order. */
export function PlatformPicker({ children }: { children: ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: detect }} />
      <div className={styles.picker}>{children}</div>
    </>
  );
}

/** One download button per platform; the visitor's own comes first as the primary button. Without
 *  JavaScript the first one is primary. */
export function PlatformButtons({ links }: { links: { platform: Platform; label: string; href: string }[] }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: detect }} />
      <div className={styles.platformButtons}>
        {links.map((l) => (
          <Link
            key={l.platform}
            className={cx(styles.button, styles.secondary)}
            data-platform={l.platform}
            href={l.href}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </>
  );
}

export function Callout({ children }: { children: ReactNode }) {
  return <aside className={styles.callout}>{children}</aside>;
}

export interface Partner {
  name: string;
  description: string;
  url: string;
  logo: string;
  logoDark: string;
}

export function PartnerCard({ partner }: { partner: Partner }) {
  const base = useBaseUrl("/");
  const url = (p: string) => (p.startsWith("/") ? base + p.slice(1) : p);
  return (
    <div className={styles.card}>
      <img className={cx(styles.partnerLogo, styles.onlyLight)} src={url(partner.logo)} alt="" height={32} />
      <img className={cx(styles.partnerLogo, styles.onlyDark)} src={url(partner.logoDark)} alt="" height={32} />
      <h3>{partner.name}</h3>
      <p>{partner.description}</p>
      <div className={styles.cardActions}>
        <ButtonLink href={partner.url} variant="secondary">
          {`Visit ${partner.name}`}
        </ButtonLink>
      </div>
    </div>
  );
}
