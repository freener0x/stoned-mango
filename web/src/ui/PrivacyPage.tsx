// The privacy promise, and how anyone can check it.

export function PrivacyPage() {
  return (
    <main className="page prose">
      <h1>Privacy</h1>
      <p className="lead">Your music never leaves your device. That isn’t a policy we ask you to trust: the app is built so it
        doesn’t send your music anywhere, and you can check that yourself.</p>

      <section>
        <h2>What happens to your files</h2>
        <ul>
          <li>Songs are read and analysed <strong>inside this page, on your device</strong>. There is no server to upload them to:
            the site is only static files.</li>
          <li>Results stay in this tab’s memory. They are gone when you close it, unless you export them yourself; exports are
            made on your device.</li>
          <li>Key tags are only written when you ask, and only to the files you choose. In Chrome and Edge your browser asks
            your permission first.</li>
        </ul>
      </section>

      <section>
        <h2>What is stored</h2>
        <ul>
          <li><strong>Your settings</strong> (skin, key display, and so on), in this browser’s storage. Nothing else: no results,
            no file names.</li>
          <li><strong>The app itself</strong>, so it works offline: its own code and model, never your music.</li>
          <li>No accounts, no cookies, no analytics, no ads, no third-party scripts or fonts.</li>
        </ul>
      </section>

      <section>
        <h2>Check it yourself</h2>
        <ol>
          <li><strong>Turn off your internet</strong> (Wi-Fi off or airplane mode) once the page has loaded, then analyse some songs.
            Everything still works, because nothing needs to be sent.</li>
          <li><strong>Watch the network.</strong> In a desktop browser, open the developer tools (F12), choose the Network tab, and
            analyse a folder. No request appears.</li>
          <li><strong>Read the security policy.</strong> In the same tools, the page’s <code>Content-Security-Policy</code> header
            includes <code>connect-src 'self'</code>: the browser itself refuses the page’s uploads and other requests to any
            other site. The libraries that analyse your music run in background workers under the same rule.</li>
          <li><strong>Read the code.</strong> It’s open source (AGPL-3.0), and the published site is built from it automatically.
            An automated test analyses files in a real browser on every change and fails if the page makes any web request
            while it analyses.</li>
        </ol>
      </section>

      <section>
        <h2>The fine print</h2>
        <p>Like any website, the host (Cloudflare Pages) sees that someone loaded the page: an IP address in its access logs. It
          never sees your music, file names or results. Opening a donation link takes you to that payment site, under its own
          privacy policy. You can also run stoned-mango yourself, fully offline, from the source code.</p>
      </section>
    </main>
  );
}
