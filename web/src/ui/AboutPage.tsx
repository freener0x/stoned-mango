// What the app is, and the privacy promise in short (the full Privacy and Accuracy pages come with the launch).

export function AboutPage({ offline }: { offline: boolean }) {
  return (
    <main className="page about">
      <h1>About stoned-mango</h1>
      <p>Finds the key and mode of your music: major and minor, the church modes (Dorian, Mixolydian…), harmonic and melodic minor
        and their modes, pentatonic and blues scales. It also shows where a song changes key, and the DJ codes (Camelot, Open Key).</p>

      <h2>Your music never leaves your device</h2>
      <p>More on the <a href="#/privacy">Privacy</a> page, including how to check it yourself.</p>
      <ul>
        <li>Songs are analysed inside this page, on your device. There is no server to upload them to.</li>
        <li>Results stay in this tab’s memory and are gone when you close it. Exports are made on your device.</li>
        <li>No accounts, cookies, analytics or ads. Only your settings are saved, in this browser.</li>
        <li>{offline ? 'This app is saved on this device and works offline: try it with Wi-Fi off.' : 'Once loaded, the app is saved on this device and works offline.'}</li>
      </ul>

      <h2>How sure is it?</h2>
      <p>No key finder is right every time. Each result comes with a confidence, the next most likely keys, and a note when the
        music genuinely can’t decide (for example when the note that tells two modes apart is never played). Mistakes are usually
        close relatives: a fifth away, or the relative major or minor. The measured numbers are on the
        {' '}<a href="#/accuracy">Accuracy</a> page.</p>

      <h2>Free and open source</h2>
      <p>Licensed under the GNU AGPL 3.0 or later; the key model under CC BY-SA 4.0. Anyone can read the code, check these promises
        and run their own copy: <a href="https://github.com/freener0x/stoned-mango" rel="noreferrer">source code</a>. It includes
        open-source libraries under their own licences: <a href={`${import.meta.env.BASE_URL}third-party-licenses.txt`}>third-party
        licences</a>.</p>
    </main>
  );
}
