# Wait for a persistent Fanqie editor before writing

**Status: accepted**

Fanqie's new-chapter route first exposes a temporary blank editor, then assigns a persistent draft ID and remounts its controlled fields; content written to the temporary tree can appear correct and disappear one or two seconds later. The workflow therefore waits for the persistent draft route, stable field nodes, and top editor-action evidence before writing, then requires the complete chapter to remain unchanged for 2.5 seconds. If the same draft replaces that tree with one verified-empty tree, the workflow may refill it exactly once; any non-empty difference stops. The real “下一步” may be a ByteDance custom control rather than a semantic button, so it is accepted only as an exact, small, enabled top-bar action while lower dialogs and tutorials remain excluded. This adds a few seconds of latency to avoid both transient writes and clicks on tutorial controls.
