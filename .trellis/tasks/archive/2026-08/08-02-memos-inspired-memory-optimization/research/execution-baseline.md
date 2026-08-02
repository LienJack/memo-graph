# Execution baseline

Captured on 2026-08-02 before product-code changes.

## Repository identity

- Branch: `codex/agent-memory-runtime-m6`
- HEAD: `92c12d479e1621ffa0f884c15e5b23366eec0f29`
- Product worktree state: clean; only the new Trellis task directory was untracked.
- Lockfile SHA-256: `bec39249d689cd4274654cf6b026dbd1122041fe9beae6c6116521032a70a5d0`
- Required runtime: `/Users/lienli/.nvm/versions/node/v24.18.0/bin/node`
- Interactive shell runtime observed before PATH pinning: Node `v26.3.0`, pnpm `10.33.2`.

All implementation and evidence gates must prepend `/Users/lienli/.nvm/versions/node/v24.18.0/bin` to `PATH`.

## Migration hashes

```text
707146d45e5f6d5e4c31740a85cd7eb81c43ec379bd39b2600cde533515e8e11  migrations/0001-evidence-ledger.sql
b70b77de89023929151ba1440d1a8971b7179bde9a5c40f529db6c99a74166f8  migrations/0002-fts-baseline.sql
ed6d7538ee160a75bfdde47e58a131d98a172038a5c8615823766aa7babdd69b  migrations/0003-recall-context.sql
979ef6ec5fec074a2a3c6b12b84dc44f389575b5b2ff73b5b65bc7032e17b7c6  migrations/0004-l1-governance.sql
5b99ba87d3c6a398ab2ca3884f3f0f1a0f055252a80a00f36985209cd81fe51b  migrations/0005-tombstone-purge.sql
6f977f7c686d78a8b630f529d7644a6289038717e3738ddfa77e4997eb580668  migrations/0006-governance-commands.sql
1314180cb2b28925efc37765236c180912c4b34fff3a6dd23e5f14e6605c4392  migrations/0007-purge-runtime.sql
cbb5b9fc97936964c1cc2d3b3e86cd5952c5de46e172dd85b9ff5668a7caec62  migrations/0008-layered-projections.sql
91aca5edcb00e5ba67c74a2304593543bd21c56bc1c5196444b9149daaba5033  migrations/0009-projection-purge-redaction.sql
21b29ee3552a2ad93adb8be07fa5fb511c9f70f1021502091918bf69ac96bff1  migrations/0010-layered-context-purge.sql
072d3092b7d6ec634ba90e09ad84897619529199b6c9b6a3d4a1981ca46e25a6  migrations/0011-scope-projection-frontiers.sql
5242e089722376e59056cd8d8014eaeeb4656f2ab32e0467b7f5e641902b465b  migrations/0012-graph-projection-delivery.sql
2f9df2534a4287a8ecd5df25c05caff6922aa26ba2b18fc97de61fdf6d56a3e8  migrations/0013-vector-projection-delivery.sql
72ed4be94159bfd87a461ee1928659bed9e18c0c27dea42f3a4bcf60c29c70bf  migrations/0014-learning-lab.sql
196f4f85c22bff95d3e09233fe5aff457df4a1b2db3414d37e19bda0c8eadecc  migrations/0015-operational-hardening.sql
64dccc63c541426d3c141f5ee8dc9959d017897ba190d90b154f60c783075208  migrations/0016-complete-recovery.sql
18583d5385a260c02f2e9f6fec38c07ee4a627028370f2d7d6e5986c7f1d7d76  migrations/0017-operator-repair-audit.sql
648dd62d74ac28e1cd99941e406f69f46605d2d272fca9eb0a8359187e6b2c44  migrations/0018-purge-physical-saga.sql
c03bda92963ebfdf98eeb03a8e1fb7e8851706d59984ffad7507a5f06eeb55cb  migrations/0019-incremental-recovery-frontier.sql
```

## Immutable legacy G6 artifact hashes

```text
47b7d96acb2c2bef1bcc3e51b7b39c7d053593c5d62ee7faff92274e20f32ed1  docs/evaluations/g6-code-review.md
365e2783169f7c93ec0b7e1491bba5e3ce62eb37c30666b18c9f5811e828f8a3  docs/evaluations/g6-fault-report.json
9f71db2f30d7f2e375ca1fd18af0f7a674aa00789f726f7fbb8669419818b2ea  docs/evaluations/g6-reproducibility-manifest.json
32c2e4384d2bc9e54d8993f1bb385ee789dee8acf267acffe4a337e98207080e  docs/evaluations/g6-resource-report.json
c41b8d91fedfb7cf1d2203ea20591a7a0a60bd37d4f45934da7ef4e6f526d496  docs/evaluations/g6-runbook-report.json
104116ecb750c8d1bf1dd0c00388ed3a9336cbb0d0cf848ee585b55c0d6ce3a3  docs/evaluations/g6-security-report.json
491fe7332c42e6b6e50787656a560a575eceab979f1838504d8238c5a8cc036e  docs/evaluations/g6-supply-chain-report.json
be7eed1ad7ceed48bf61351b720c02a5ee753123298965ba9259805cc2ff1ba7  docs/evaluations/g6-verification-report.json
e633e767086f2cff5bf9f659cdb13d5becae06bb4a56deb060762655ad435241  docs/evaluations/g6-decision.md
9010f43210c66e9832568fae778043b485e0a040d444e00122598743184344a5  docs/evaluations/g6-handoff.md
8fec20ff94e5b0b093bb635850223fe4687ad0fdb1bf67e0c153d747e1a454a1  docs/evaluations/g6-release-control.json
```
