# packages/context-compiler/src/index.ts:311

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `compileContext`
- Why: The baseline deterministically sorts, deduplicates L0 under governed L1, enforces a hard global token budget, freezes hashes, and seals inclusion/exclusion receipts, but has no lane quotas or L2/L3 candidates.

````typescript
   311  export function compileContext(input: unknown): CompileContextResult {
   312    const parsed = CompileContextInputSchema.parse(input);
   313    const ordered = [...parsed.candidates].sort(candidateOrder);
   314    const seenCandidates = new Set<string>();
   315    const identityUnique = ordered.filter((candidate) => {
   316      const key =
   317        candidate.abstraction === "l0_evidence"
   318          ? `evidence:${candidate.evidence.evidence_id}`
   319          : `memory:${candidate.memory.memory_id}:${candidate.memory.revision_id}`;
   320      if (seenCandidates.has(key)) {
   321        return false;
   322      }
   323      seenCandidates.add(key);
   324      return true;
   325    });
   326    const governedEvidenceIds = new Set(
   327      identityUnique.flatMap((candidate) =>
   328        candidate.abstraction === "l1_memory"
   329          ? candidate.memory.evidence_ids
   330          : [],
   331      ),
   332    );
   333    const unique = identityUnique.filter(
   334      (candidate) =>
   335        candidate.abstraction === "l1_memory" ||
   336        !governedEvidenceIds.has(candidate.evidence.evidence_id),
   337    );
   338    const classified = unique.map((candidate) =>
   339      classifyCandidate(candidate, parsed.request),
   340    );
   341    const included: ClassifiedCandidate[] = [];
   342    const exclusions = new Map<string, string>();
   343    let tokenUsed = 0;
   344
   345    for (const candidate of classified) {
   346      if (candidate.item === null) {
   347        exclusions.set(
   348          `${candidate.memoryId}:${candidate.revisionId}`,
   349          candidate.exclusion ?? "POLICY_EXCLUDED",
   350        );
   351        continue;
   352      }
   353      if (
   354        tokenUsed + candidate.item.token_estimate >
   355        parsed.request.token_budget
   356      ) {
   357        exclusions.set(
   358          `${candidate.memoryId}:${candidate.revisionId}`,
   359          "BUDGET_EXCEEDED",
   360        );
   361        continue;
   362      }
   363      included.push(candidate);
   364      tokenUsed += candidate.item.token_estimate;
   365    }
   366
   367    const contextSlice =
   368      included.length === 0
   369        ? null
   370        : ContextSliceSchema.parse({
   371            schema_version: "1.0.0",
   372            context_slice_id: stableIdentifier("context", {
   373              request_id: parsed.request.request_id,
   374              item_ids: included.map(
   375                (candidate) =>
   376                  `${candidate.memoryId}:${candidate.revisionId}`,
   377              ),
   378            }),
   379            request_id: parsed.request.request_id,
   380            compiler_version: CONTEXT_COMPILER_VERSION,
   381            created_at: parsed.created_at,
   382            token_budget: parsed.request.token_budget,
   383            token_used: tokenUsed,
   384            items: included.map((candidate) => candidate.item),
   385            frozen_hash: `sha256:${"0".repeat(64)}`,
   386          });
   387    const sealedContextSlice =
   388      contextSlice === null
   389        ? null
   390        : ContextSliceSchema.parse({
   391            ...contextSlice,
   392            frozen_hash: canonicalSha256Omitting(contextSlice, [
   393              "frozen_hash",
   394            ]),
   395          });
   396
   397    const degradedLanes = [...new Set(parsed.degraded_lanes)].sort();
   398    const status =
   399      degradedLanes.length > 0
   400        ? "DEGRADED"
   401        : included.length > 0
   402          ? "OK"
   403          : classified.length === 0 && parsed.exclusions.length === 0
   404            ? "NO_MATCH"
   405            : "POLICY_EXCLUDED";
   406    const receiptItems: Array<{
   407      memory_id: string;
   408      revision_id: string;
   409      decision: "included" | "excluded";
   410      reason_codes: string[];
   411      lane: string;
   412      score: number | null;
   413    }> = classified.map((candidate) => {
   414      const reason = exclusions.get(
   415        `${candidate.memoryId}:${candidate.revisionId}`,
   416      );
   417      return {
   418        memory_id: candidate.memoryId,
   419        revision_id: candidate.revisionId,
   420        decision: reason === undefined ? "included" : "excluded",
   421        reason_codes:
   422          reason === undefined
   423            ? candidate.candidate.abstraction === "l1_memory"
   424              ? candidate.candidate.memory.reason_codes
   425              : ["RANKED_EVIDENCE"]
   426            : [reason],
   427        lane: candidate.candidate.lane,
   428        score: candidate.candidate.rank,
   429      };
   430    });
   431    for (const exclusion of parsed.exclusions) {
   432      exclusions.set(
   433        `${exclusion.memory_id}:${exclusion.revision_id}`,
   434        exclusion.reason_code,
   435      );
   436      receiptItems.push({
   437        memory_id: exclusion.memory_id,
   438        revision_id: exclusion.revision_id,
   439        decision: "excluded",
   440        reason_codes: [exclusion.reason_code],
   441        lane: exclusion.lane,
   442        score: exclusion.score,
   443      });
   444    }
   445    const receipt = RetrievalReceiptSchema.parse(
   446      sealReceipt({
   447        schema_version: "1.0.0",
   448        receipt_id: stableIdentifier("retrieval", {
   449          request_id: parsed.request.request_id,
   450          context_slice_id: sealedContextSlice?.context_slice_id ?? null,
   451          status,
   452          items: receiptItems,
   453        }),
   454        created_at: parsed.created_at,
   455        state: degradedLanes.length > 0 ? "partial" : "durable",
   456        request_hash: canonicalSha256(parsed.request),
   457        receipt_hash: `sha256:${"0".repeat(64)}`,
   458        kind: "retrieval",
   459        context_slice_id: sealedContextSlice?.context_slice_id ?? null,
   460        compiler_version: CONTEXT_COMPILER_VERSION,
   461        policy_version: CONTEXT_POLICY_VERSION,
   462        items: receiptItems,
   463      }),
   464    );
   465    return CompileContextResultSchema.parse({
   466      status,
   467      context_slice: sealedContextSlice,
   468      receipt,
   469      excluded_count: exclusions.size,
   470      reason_codes: [...new Set(exclusions.values())].sort(),
````
