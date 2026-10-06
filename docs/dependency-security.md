# 依存関係のセキュリティ更新

## 2026-10-06 の更新

- Elysia の必須 peer dependency `file-type` を `21.3.4` に固定した。ASF 解析と ZIP 展開の DoS 修正を取り込み、`fflate` に依存しない `@tokenizer/inflate` に更新した。
- `lint-staged` は同一メジャーの `16.4.0` に更新した。`micromatch` / `braces` を使わない依存構成に移行し、`picomatch` と `yaml` も修正版に更新した。
- Prisma の間接依存 `defu` は既存の互換バージョン範囲内で `6.1.7` に更新した。
- テストでは Bun のテストランナーと `Elysia.handle()` を使用しているため、未使用の `supertest` と `@types/supertest` を削除した。これにより `form-data` と `qs` を含む不要な依存関係も削除した。

## Prisma の一時的な override

Prisma `6.19.3` の `@prisma/config` は脆弱な `deepmerge-ts@7.1.5` を完全固定している。修正版は `8.x` のため、`package.json` の `overrides` で `8.0.2` を指定する。

Prisma 内部の利用箇所は `c12` に渡す `deepmerge` 関数のみである。`8.x` の破壊的変更は Map 値の再帰マージ、`deepmergeInto` の変更、および型名の変更であり、本プロジェクトのプレーンオブジェクトによる設定では該当しない。Prisma 本体とクライアントは同じ `6.19.3` を維持する。

この override は上流で修正版を採用するまでの対策である。Prisma 更新時には依存関係を再確認し、override が不要になったら削除する。設定に Map や独自マージ処理を追加する場合は、その挙動を別途検証する。

検証には `src/tests/dependency-compatibility.test.ts` の Prisma 設定読み込みと Elysia のファイル種別検証、Prisma Client 生成、スキーマ検証、型検査、全テストを使用する。設定読み込みのテストは一時ディレクトリで実行し、データベースを変更しない。

## 参照

- [deepmerge-ts の脆弱性](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)
- [deepmerge-ts 8.0.0 の変更点](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0)
- [Prisma の上流課題](https://github.com/prisma/orm/issues/30052)
- [braces の未修正脆弱性](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
- [file-type の ASF 解析の脆弱性](https://github.com/advisories/GHSA-5v7r-6r5c-r473)
- [file-type の ZIP 展開の脆弱性](https://github.com/advisories/GHSA-j47w-4g3g-c36v)
