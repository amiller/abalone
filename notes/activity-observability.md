# Answer activity: inputs, execution, and retention

User feedback, 9 October 2026: the shell walkthrough did not make it possible to tell whether an answer was one model call, involved tools, consulted related files or memories, or saved a local trace. These facts should be easy to inspect without filling the main transcript with diagnostics.

## User-facing requirement

Each answer has a compact, keyboard-accessible **Activity** disclosure. It opens the record for the corresponding user request. It distinguishes:

- Automatic context preparation, including `@file` extraction and folder-name/size listings.
- Context actually supplied to each model request: current messages, earlier session context, file content, runtime instructions and skill catalog, retrieved memories, and any explicitly reopened trace. Permission to read a source is not evidence that it was read. Newly read content and previously supplied content are different facts.
- Actual model requests, destinations, completion/failure/retry state. One user turn is not necessarily one model request.
- Model-requested tools: requested, executed, refused, failed, or cancelled; arguments and results available on expansion. An automatic PDF extraction is not a model-requested tool call.
- File changes, with paths and results.
- Trace writer state, exact local location, encryption state, and how to reopen it. User-created output files and terminal scrollback must not be described as encrypted merely because the trace is encrypted.

Keep the ordinary transcript readable. A short activity affordance and a confirmed save indication are enough when closed. Do not ask the model to reconstruct the record. Unknown or uninstrumented activity must be labeled as such; it must not become a confident zero or “nothing else read.”

## Inspected source behavior and gap

At source revision `25278be`, `curated/abalone.ts`'s context hook adds `listing(cwd)` and the extracted text of `@file` mentions to outbound request messages. `lib/mediate.mjs` implements that extraction and listing. The first request therefore contains folder metadata as well as the named document and the normal runtime context. The available-skill list is appended to the system prompt.

Strict incognito skips automatic notebook writes. This does not justify a generic claim that no memory-like context could exist: an explicitly reopened trace is inserted into the conversation, and all actual retrieval or read activity must be accounted for.

The context hook explicitly adds extracted blocks to the request, not to the transcript. The encrypted trace writer saves session entries. **Audit whether the saved trace captures the actual injected input snapshots before claiming it can reproduce or explain the complete model context.** A saved conversation alone is not necessarily a complete input record. Re-extraction of earlier `@file` mentions must also be represented accurately if the underlying file changes.

## Completion evidence for the implementation worker

Use bounded synthetic runs to demonstrate a one-request answer with automatically loaded PDF text; a request that executes tools and requires another model request; a denied tool; a memory or reopened-trace case; and a trace-write failure. Check that the collapsed display stays short and its expanded record agrees with request, tool, and persistence events. A later turn must distinguish earlier conversation context from new reads, and must not reuse stale counts.

Show one captured real interaction when the telemetry is wired. Brochure counters and save acknowledgments remain explicitly illustrative until tied to such a run. This is an implementation acceptance requirement, not a request for the editorial agent to change runtime code or repeat already-passing unrelated tests.
