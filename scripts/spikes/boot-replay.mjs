/**
 * G6: Boot replay after daemon kill mid-turn.
 *
 * Validates that:
 *  - markStalePending marks dispatched-but-unfinished rows
 *  - On daemon boot, replay walks those rows and re-dispatches
 *  - The user's original prompt actually gets re-processed
 *
 * This is a polygram-internal flow that can be tested without
 * burning Anthropic tokens — it stops at the dispatch step.
 *
 * DESTRUCTIVE: this script is NOT runnable standalone. It needs
 * a polygram-daemon-test-harness which we haven't built yet.
 *
 * For now, this is a documented procedure rather than executable code:
 *
 *   1. Run polygram against a test bot in a sandboxed cwd.
 *   2. Send a long prompt: "Run /tmp/long-script.sh and report the
 *      output." that takes 30+ seconds.
 *   3. After the SDK Query is in flight (verify via
 *      tmux capture-pane on the test polygram window):
 *      `kill -9 <polygram-pid>`
 *   4. Restart polygram. Watch the boot log for:
 *      `[db] marked N stale pending rows as failed`
 *      `[<bot>] replay: N inbound rows`
 *   5. Verify the user receives the reply (or appropriate error)
 *      after restart.
 *
 * Pass criterion: re-dispatch event in events table for the
 * original msg_id within 5s of boot.
 *
 * Reference: lib/db.js:markStalePending, polygram.js's boot replay
 * loop (search for 'replay' in handleMessage's caller).
 */

console.log(`\nThis spike is a manual procedure documented in the file header.

To verify boot replay end-to-end:

  1. Run polygram against a test bot.
  2. Send a long prompt that triggers a 30s+ turn.
  3. Once the SDK Query is in flight, kill -9 the polygram process.
  4. Restart polygram — watch boot log for:
       [db] marked N stale pending rows as failed
       [<bot>] replay: N inbound rows
  5. Confirm the user gets a reply (or graceful error).

Until we have a polygram-daemon test harness this is not auto-run.`);

process.exit(0);
