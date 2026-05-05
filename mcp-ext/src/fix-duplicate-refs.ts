/**
 * One-shot maintenance: collapse multi-character inline reference runs.
 *
 * Background
 * ----------
 * Before the fix in block-builder.ts toDelta() / write-tools.ts, the proxy
 * inserted the caller-provided label text (e.g. "Datový model" — 12 chars)
 * with a `reference` attribute attached. BlockSuite's inline reference
 * renderer is invoked PER CHARACTER carrying that attribute, so 12 chars
 * rendered as 12 duplicate @DocName pills. The upstream fix emits a single
 * SPACE placeholder; this script repairs documents that were written under
 * the old behaviour.
 *
 * What it does
 * ------------
 * For each non-trashed doc in the workspace, it walks every block's
 * prop:title and prop:text Y.Text. For every delta run with a `reference`
 * attribute and length > 1, it replaces the run with a single-space
 * placeholder carrying the same reference. Idempotent — re-running after a
 * clean pass is a no-op.
 *
 * Trade-off
 * ---------
 * If two adjacent inline references happen to point to the same docId,
 * Yjs may have merged them into one >1-char delta run on disk — this
 * script would collapse them into ONE pill. In practice this does not
 * happen organically (people don't write "@A@A"), and the visible damage
 * from leaving the bug far outweighs the risk. Run with --dry-run first
 * to inspect what would change.
 *
 * Usage (inside the mcp_ext container, where AFFINE_BASE_URL etc. are set)
 * -----
 *   docker exec -e AFFINE_TOKEN=<your-ws-token> affine_mcp_ext \
 *     npx tsx src/fix-duplicate-refs.ts --dry-run
 *
 *   docker exec -e AFFINE_TOKEN=<your-ws-token> affine_mcp_ext \
 *     npx tsx src/fix-duplicate-refs.ts
 *
 * AFFINE_TOKEN can also be omitted if AFFINE_ACCESS_TOKEN is set on the
 * container (the proxy's fallback token).
 */

import * as Y from 'yjs';
import { config } from './config.js';
import { openSession } from './yjs-writer.js';
import { listPages, type PageMeta } from './doc-store.js';
import { getBlocksMap } from './block-builder.js';

interface RunFix {
  at: number;
  len: number;
  ref: unknown;
}

function collectFixes(text: Y.Text): RunFix[] {
  const delta = text.toDelta() as Array<{ insert: string; attributes?: Record<string, unknown> }>;
  const fixes: RunFix[] = [];
  let pos = 0;
  for (const op of delta) {
    const len = op.insert.length;
    if (op.attributes?.reference && len > 1) {
      fixes.push({ at: pos, len, ref: op.attributes.reference });
    }
    pos += len;
  }
  return fixes;
}

function applyFixes(text: Y.Text, fixes: RunFix[]): void {
  // Apply in reverse so earlier offsets stay valid as we shrink the text.
  for (let i = fixes.length - 1; i >= 0; i--) {
    const f = fixes[i];
    text.delete(f.at, f.len);
    text.insert(f.at, ' ', { reference: f.ref });
  }
}

interface DocReport {
  page: PageMeta;
  blocksTouched: number;
  runs: number;
  chars: number;
}

async function fixDoc(
  session: Awaited<ReturnType<typeof openSession>>,
  page: PageMeta,
  dry: boolean,
): Promise<DocReport | null> {
  const doc = await session.load(page.id);
  if (!doc) return null;
  const preVector = Y.encodeStateVector(doc);

  let blocksTouched = 0;
  let runs = 0;
  let chars = 0;

  const blocks = getBlocksMap(doc);
  for (const [, block] of blocks) {
    for (const key of ['prop:title', 'prop:text']) {
      const v = block.get(key);
      if (!(v instanceof Y.Text)) continue;
      const fixes = collectFixes(v);
      if (fixes.length === 0) continue;
      blocksTouched += 1;
      runs += fixes.length;
      for (const f of fixes) chars += f.len;
      if (!dry) applyFixes(v, fixes);
    }
  }

  if (!dry && runs > 0) {
    const update = Y.encodeStateAsUpdate(doc, preVector);
    if (update.length > 2) await session.push(page.id, update);
  }

  return runs > 0 ? { page, blocksTouched, runs, chars } : null;
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry-run');
  const token =
    process.env.AFFINE_TOKEN ??
    process.env.AFFINE_ACCESS_TOKEN ??
    config.fallbackToken;
  if (!token) {
    console.error('No token: set AFFINE_TOKEN or AFFINE_ACCESS_TOKEN env var.');
    process.exit(1);
  }

  console.log(
    `[fix-duplicate-refs] mode=${dry ? 'dry-run' : 'write'} workspace=${config.workspaceId} affine=${config.affineBaseUrl}`,
  );

  const session = await openSession(token);
  let totalDocs = 0;
  let totalRuns = 0;
  let totalChars = 0;
  let totalBlocks = 0;

  try {
    const root = await session.load(config.workspaceId);
    if (!root) {
      console.error('Workspace root doc not found — wrong workspaceId?');
      process.exit(1);
    }
    const pages = listPages(root).filter(p => !p.trash);
    console.log(`Scanning ${pages.length} non-trashed docs.`);

    for (const page of pages) {
      try {
        const report = await fixDoc(session, page, dry);
        if (report) {
          totalDocs += 1;
          totalBlocks += report.blocksTouched;
          totalRuns += report.runs;
          totalChars += report.chars;
          const label = (report.page.title || report.page.id).padEnd(40).slice(0, 40);
          console.log(
            `${dry ? '[dry] ' : '      '}${label}  ${String(report.runs).padStart(3)} runs · ${String(report.chars).padStart(5)} chars · ${report.blocksTouched} blocks`,
          );
        }
      } catch (err) {
        console.error(`  ! ${page.title || page.id}: ${(err as Error).message}`);
      }
    }
  } finally {
    session.close();
  }

  console.log(
    `\n${dry ? '[dry] ' : ''}Summary: ${totalDocs} docs · ${totalBlocks} blocks · ${totalRuns} ref-runs · ${totalChars} chars`,
  );
  if (dry && totalRuns > 0) console.log('Re-run without --dry-run to apply.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
