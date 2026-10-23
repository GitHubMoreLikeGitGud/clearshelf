# ClearShelf demo video: narration script

Spoken by a synthetic text-to-speech voice. Times are the start of each line in `clearshelf-demo.mp4`; the burned-in captions and `clearshelf-demo.srt` use the same text. Numbers are read from `docs/eval-report.md` or from the screen at that moment.

**0:00.6** ClearShelf: allergen clearance and recall watch for online grocers.

**0:05.7** A solo entry from Singapore.

**0:08.6** Open Food Facts tags these Plant-Based Puffs as vegan. The FDA says they tested positive for milk. An online grocer's compliance officer must catch that before the listing goes live.

**0:24.7** The officer pastes a barcode and picks the UK.

**0:30.4** Each step streams as the local Nemotron model plans it: the product row, the recall notice, the data-quality gate, memory. Every read goes through Zetaris.

**0:42.8** In Zetaris, each product is a live REST table beside the openFDA and FSA feeds, and the clearance_usl semantic layer joins them with keys and data-quality rules.

**1:04.5** The result: HOLD, applied automatically, since holding needs no signature. Each chip opens its evidence: the exact Lightning SQL, the source, the licence and the cache time.

**1:19.3** Why was this held? Five plain lines: the recall, the missing ingredient list, and the vegan claim that milk contradicts, each with its evidence.

**1:28.0** On this dark chocolate, a keyword rule reads milk in cocoa butter and treats "may contain" as "contains". Nemotron names no allergen there, and a verifier must agree.

**1:39.4** Clearing always needs the officer: the form shows what will be signed, the server issues a single-use contract, and only then is the decision written.

**1:53.5** Zetaris reads the signed row straight back.

**1:57.0** The recall watch can replay a known past: as of 10 October it sees only notices reported by then, and a banner says so.

**2:05.1** Polling to today, new notices arrive and a bounded investigation runs: each Markovian step carries a small state forward, so the prompt stays flat.

**2:15.9** An FDA notice names this cake's barcode exactly. It's a US-only recall, so the UK listing is held automatically, with the reason. Name-only matches wait for a person.

**2:28.2** Contradictions are queued, never settled by the last write. The officer resolves the milk conflict with a reason, and the ledger records who decided.

**2:41.4** The footer shows a Ritz cracker re-check reusing its verified extraction: tool tokens fall from 3,658 to 804, and 61 seconds to 48.

**2:54.4** Zetaris is the only data path, and its SQL is the citation. Meterless engines run the loop, the memory and the world model; the signed contracts follow Meterless Scout's spec. Nemotron runs on one local GPU.

**3:10.4** Measured: ten of ten scenarios pass, label precision is 1.00 against 0.71 for keywords, and nothing clears unsigned.

**3:21.6** ClearShelf. Every decision is cited, and every release is signed.
