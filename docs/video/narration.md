# ClearShelf demo video: narration script (round-3 re-cut)

Spoken by a synthetic text-to-speech voice (the same voice as the first cut). Times are the start of each line in `clearshelf-demo-v2.mp4`; the burned-in captions and `clearshelf-demo.srt` use the same text. Numbers are read from `docs/eval-report.md` or from the screen at that moment.

**0:00.4** Open Food Facts tags these Plant-Based Puffs as vegan. The FDA says they tested positive for milk.

**0:08.3** A shopper with a milk allergy could trust that tag. ClearShelf holds the listing automatically, cites every reason, and clears nothing without the compliance officer's signature.

**0:22.1** The officer pastes a barcode and picks the UK.

**0:27.9** Each step streams as the local Nemotron model plans it: the product row, the recall notice, the data-quality gate, memory. Every read goes through Zetaris.

**0:40.2** Zetaris joins the three sources in one semantic layer with 22 data-quality rules; a failed rule holds the listing.

**0:48.6** The result: HOLD, applied automatically, since holding needs no signature. Each chip opens its evidence: the exact Lightning SQL, the source, the licence and the cache time.

**1:03.3** Why was this held? Five plain lines: the recall, the missing ingredient list, and the vegan claim that milk contradicts, each with its evidence.

**1:12.0** On this dark chocolate, a keyword rule reads milk in cocoa butter and treats "may contain" as "contains". Both readers, Nemotron and the verifier, call these "may contain".

**1:23.4** Clearing always needs the officer: the form shows what will be signed, the server issues a single-use contract, and only then is the decision written.

**1:37.6** Zetaris reads the signed row straight back.

**1:41.1** The recall watch can replay a known past: as of 10 October it sees only notices reported by then, and a banner says so.

**1:49.1** Polling to today, new notices arrive and a bounded investigation runs: each Markovian step carries a small state forward, so the prompt stays flat.

**1:58.4** Paused on two of Nemotron's notes. It picks each step from the host's checklist: check the FDA recall for this barcode, then parse the notice found, to confirm the barcode and the allergen.

**2:11.1** An FDA notice names this cake's barcode exactly. It's a US-only recall, so the UK listing is held automatically, with the reason. Name-only matches wait for a person.

**2:23.4** Contradictions are queued, never settled by the last write. The officer resolves the milk conflict with a reason, and the ledger records who decided.

**2:37.6** Zetaris is the only data path, and its SQL is the citation. Meterless engines run the loop, the memory and the world model; the signed contracts follow Meterless Scout's spec. Nemotron runs on one local GPU.

**2:53.3** Measured: ten of ten scenarios pass; in ten replayed recall polls, the matched listing was held in a median of 68.4 seconds; and nothing clears unsigned.

**3:06.3** ClearShelf. Every decision is cited, and every release is signed.

**3:10.4** A solo entry from Singapore.
