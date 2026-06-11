import { CopyButton } from "@/components/copy-button";

const INSTALL = "npm i -g up";
const CHANGELOG = "https://vercel.com/changelog/sandbox-persistence-is-now-ga";
const DOCS = "https://vercel.com/docs/sandbox/concepts/persistent-sandboxes";
const REPO = "https://github.com/vercel-labs/upcli";

export default function Page() {
  return (
    <main>
      <section className="hero">
        <div className="container">
          <h1 className="hero-mark">up</h1>

          <p className="hero-tagline">
            one command. your local dev server,
            <br />
            live on a public url.
          </p>

          <div className="hero-actions">
            <CopyButton text={INSTALL} />
            <a className="hero-link" href={REPO}>
              src
            </a>
          </div>

          <p className="hero-byline">
            a demo of <a href={CHANGELOG}>persistent vercel sandboxes</a>. built by vercel labs.
          </p>
        </div>

        <div className="hero-note">
          <span className="tag">experimental</span>
          <span>
            we recommend trying it on experimental workloads, not production projects or real data.
          </span>
        </div>
      </section>

      <section className="how">
        <div className="container">
          <h2 className="how-title">how it works</h2>

          <ol className="steps">
            <li className="step">
              <span className="step-label">sync</span>
              <span className="step-desc">
                up uploads your working directory into a fresh Vercel Sandbox, and keeps it in sync
                as you edit.
              </span>
            </li>
            <li className="step">
              <span className="step-label">run</span>
              <span className="step-desc">
                inside the sandbox it detects your framework, installs dependencies, and starts your
                dev server.
              </span>
            </li>
            <li className="step">
              <span className="step-label">share</span>
              <span className="step-desc">
                that running dev server is proxied out to a public url anyone can open.
              </span>
            </li>
            <li className="step">
              <span className="step-label">resume</span>
              <span className="step-desc">
                stop it and the sandbox saves a snapshot; the next <code>up .</code> restores it,
                files and installed deps in place, instead of starting over.
              </span>
            </li>
          </ol>

          <p className="how-note">
            that last step is <a href={DOCS}>Vercel Sandbox persistence</a>, now generally
            available.
          </p>
        </div>
      </section>

      <footer className="footer">
        <div className="container footer-inner">
          <span>up</span>
          <div className="footer-links">
            <a href={DOCS}>docs</a>
            <a href={CHANGELOG}>changelog</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
