// Scoring + pair-selection, inspired by the All Our Ideas pairwise wiki survey.
//
// score = posterior mean of a Beta(wins + a, losses + b) distribution, scaled to
// 0..100. The prior (a = b = PRIOR/2) centres every new idea at 50, i.e. "even
// odds of beating a random other idea". As real votes accumulate, the score
// converges to the true win rate. This is the property AoI relies on.

const PRIOR = 2; // strength of the prior (1 virtual win + 1 virtual loss)

function score(idea) {
  const a = idea.wins + PRIOR / 2;
  const b = idea.losses + PRIOR / 2;
  return Math.round((a / (a + b)) * 100);
}

// 95% lower bound is not needed for the simple UI, but we expose total votes so
// the UI can convey confidence.
function decorate(idea) {
  return {
    id: idea.id,
    text: idea.text,
    wins: idea.wins,
    losses: idea.losses,
    appearances: idea.appearances,
    votes: idea.wins + idea.losses,
    score: score(idea),
  };
}

// Active sampling: prefer ideas that have been seen the least so coverage stays
// even and freshly-added ideas get a fair shot. We pick the first member from
// the least-seen third (randomised), then pick the partner with a weight that
// decays as appearances grow. Returns [ideaA, ideaB] or null if < 2 ideas.
function choosePair(ideas) {
  if (ideas.length < 2) return null;

  const sorted = [...ideas].sort((x, y) => x.appearances - y.appearances);

  // First pick: from the least-seen third (at least the bottom 2).
  const poolSize = Math.max(2, Math.ceil(sorted.length / 3));
  const first = sorted[Math.floor(Math.random() * poolSize)];

  // Second pick: weighted random over the rest, lower appearances => heavier.
  const rest = sorted.filter((i) => i.id !== first.id);
  const maxApp = Math.max(...rest.map((i) => i.appearances), 0);
  const weights = rest.map((i) => maxApp - i.appearances + 1);
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  let second = rest[rest.length - 1];
  for (let i = 0; i < rest.length; i++) {
    r -= weights[i];
    if (r <= 0) { second = rest[i]; break; }
  }

  // Randomise left/right so position carries no bias.
  return Math.random() < 0.5 ? [first, second] : [second, first];
}

module.exports = { score, decorate, choosePair, PRIOR };
