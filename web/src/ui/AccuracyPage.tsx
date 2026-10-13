// How often the app is right, measured on music it never learned from (docs/phase2-4 reports).

const ROWS: { what: string; result: string; detail: string }[] = [
  { what: 'Major and minor keys, real music', result: '0.703', detail:
    'Weighted score on GiantSteps Key: 604 electronic tracks the app never trained on (65% exactly right; most other answers are close relatives such as a fifth away or the relative major/minor, which the score counts partly). Essentia’s key finder, tuned for electronic music, scores 0.653 on the same tracks.' },
  { what: 'Home note, real music', result: '71%', detail: 'Same tracks: the right home note, whether or not major/minor is right.' },
  { what: 'Exact mode (30 scales)', result: '70%', detail:
    'On 300 test songs in all 30 scales (Dorian, Mixolydian, harmonic minor modes, pentatonic, blues…) made for testing and never used for learning. Real recordings labelled by mode are rare, so this is measured on generated songs.' },
  { what: 'Key changes', result: '93%', detail:
    'Of the key changes in 120 test songs, 93% were found within 3 seconds, and none of the songs without a change was split.' },
  { what: '“No clear key”', result: '2%', detail: 'of real tracks get “No clear key” rather than a guess (noise and drum loops always do).' },
  { what: 'Turkish makam: home note, real music', result: '84%', detail:
    'On 475 recordings of 19 makams (half of the OTMM research dataset, measured from their melodies; the other half was used to set the “last notes” clue): the home note (karar) within 25 cents. Home note and exact makam together: 49%; many makams share their notes and differ in how the melody moves, which notes alone can’t show.' },
  { what: 'Maqam, makam and raga families, test songs', result: '82%', detail:
    'On 212 songs generated for testing in all 106 scales, with their own tunings: when the app names a maqam, makam or thaat, the scale is exactly right 82% of the time and the home note 99%.' },
  { what: 'Carnatic: Sa, real music', result: '86%', detail:
    'On 477 Carnatic recordings (the CompMusic raga dataset, measured from their melodies): Sa within 25 cents, with the Indian scales chosen in Settings.' },
  { what: 'Ordinary songs wrongly named (Automatic)', result: '0 of 604', detail:
    'With the Automatic setting, none of 604 real electronic tracks (GiantSteps) got a maqam, makam or raga name. The price: Automatic recognises only about 1 in 7 real makam and 1 in 10 Carnatic recordings, so it is off by default, and “Always” for a tradition is the better choice for that music. (A first version renamed 8% of these tracks.)' },
];

export function AccuracyPage() {
  return (
    <main className="page prose">
      <h1>How accurate is it?</h1>
      <p className="lead">No key finder is right every time, and we’d rather tell you how often this one is. Every number below
        comes from music the app never learned from.</p>
      <section>
        <table className="facts">
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.what}><th scope="row">{r.what}</th><td className="mono big">{r.result}</td><td>{r.detail}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>How sure is “sure”?</h2>
        <p>Each result has a confidence. On the real tracks above, the app said about 70% on average and was right 65% of the time:
          slightly over-confident (calibration error 0.10; the goal is under 0.05, which needs more varied real music to tune
          on). Treat high-confidence answers as likely, not certain, and listen when the app adds a note such as
          “the 6th note is barely played”: that means the music genuinely can’t decide between two modes.</p>
      </section>
      <section>
        <h2>Not measured yet</h2>
        <ul>
          <li>Real recordings in modes other than major and minor (there are few labelled ones; contributions welcome).</li>
          <li>Arabic maqam and Hindustani music on real recordings. Exact raga names are a shortlist, not an answer: a raga is
            more than its notes.</li>
        </ul>
      </section>
    </main>
  );
}
