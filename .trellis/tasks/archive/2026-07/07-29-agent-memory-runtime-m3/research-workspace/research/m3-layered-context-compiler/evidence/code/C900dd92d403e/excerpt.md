# packages/memory-kernel/src/index.ts:1037

- Commit: `135f3227e72c56c5fc8a256e4064ca0635cbed24`
- Symbol: `searchScopes and searchContextScopes`
- Why: Runtime recall currently merges only exact-scope L0 FTS and canonically governed L1, names degraded lanes, and removes L0 duplicates covered by L1.

````typescript
  1037    async #searchScopes(
  1038      query: string,
  1039      scopes: ReadEnvelope["scopes"],
  1040      limit: number,
  1041    ): Promise<{ candidates: L0ContextCandidate[]; degraded: string[] }> {
  1042      const candidates: L0ContextCandidate[] = [];
  1043      const degraded: string[] = [];
  1044      for (const scope of scopes) {
  1045        const result = await this.#storage.searchEvidence({
  1046          query,
  1047          principal_id: this.#policy.principal.principal_id,
  1048          scope,
  1049          limit,
  1050        });
  1051        if (result.status === "DEGRADED") {
  1052          degraded.push(`${scopeKey(scope)}:${result.reason_code}`);
  1053          continue;
  1054        }
  1055        for (const item of result.items) {
  1056          const evidence = await this.#storage.getEvidence({
  1057            evidence_id: item.evidence_id,
  1058            principal_id: this.#policy.principal.principal_id,
  1059            scope,
  1060          });
  1061          if (evidence === null) {
  1062            throw new StorageError("CORRUPTION");
  1063          }
  1064          if (!this.#evidenceIsAllowed(evidence)) {
  1065            continue;
  1066          }
  1067          candidates.push({
  1068            abstraction: "l0_evidence",
  1069            evidence,
  1070            rank: item.rank,
  1071            lane: "sqlite_fts",
  1072          });
  1073        }
  1074      }
  1075      candidates.sort(
  1076        (left, right) =>
  1077          left.rank - right.rank ||
  1078          right.evidence.occurred_at.localeCompare(
  1079            left.evidence.occurred_at,
  1080          ) ||
  1081          left.evidence.evidence_id.localeCompare(
  1082            right.evidence.evidence_id,
  1083          ),
  1084      );
  1085      return {
  1086        candidates: candidates.slice(0, limit),
  1087        degraded: [...new Set(degraded)].sort(),
  1088      };
  1089    }
  1090
  1091    async #searchContextScopes(
  1092      query: string,
  1093      scopes: ReadEnvelope["scopes"],
  1094      limit: number,
  1095      asOf: string,
  1096      includeSensitive: boolean,
  1097    ): Promise<{
  1098      candidates: ContextCandidate[];
  1099      exclusions: ContextExclusion[];
  1100      degraded: string[];
  1101    }> {
  1102      const evidence = await this.#searchScopes(query, scopes, limit);
  1103      const candidates: ContextCandidate[] = [...evidence.candidates];
  1104      const exclusions: ContextExclusion[] = [];
  1105      const degraded = [...evidence.degraded];
  1106      for (const scope of scopes) {
  1107        const result = await this.#storage.searchGovernedMemory({
  1108          query,
  1109          principal_id: this.#policy.principal.principal_id,
  1110          scope,
  1111          as_of: asOf,
  1112          include_sensitive: includeSensitive,
  1113          context_scope: scope,
  1114          limit,
  1115        });
  1116        degraded.push(...result.degraded_lanes.map(
  1117          (lane) => `${scopeKey(scope)}:${lane}`,
  1118        ));
  1119        for (const item of result.items) {
  1120          candidates.push({
  1121            abstraction: "l1_memory",
  1122            memory: item.item,
  1123            rank: item.rank - 1_000,
  1124            lane: item.lane,
  1125          });
  1126        }
  1127        exclusions.push(...result.exclusions);
  1128      }
  1129      const governedEvidenceIds = new Set(
  1130        candidates.flatMap((candidate) =>
  1131          candidate.abstraction === "l1_memory"
  1132            ? candidate.memory.evidence_ids
  1133            : [],
  1134        ),
  1135      );
  1136      const deduplicated = candidates.filter(
  1137        (candidate) =>
  1138          candidate.abstraction === "l1_memory" ||
  1139          !governedEvidenceIds.has(candidate.evidence.evidence_id),
  1140      );
  1141      return {
  1142        candidates: deduplicated
  1143          .sort((left, right) => left.rank - right.rank)
  1144          .slice(0, limit),
  1145        exclusions,
  1146        degraded: [...new Set(degraded)].sort(),
  1147      };
````
