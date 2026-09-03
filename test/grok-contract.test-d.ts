// Compile-time assertions against our view of grok's wire contract.
// There is no published SDK to import; these lock the buckets we classify.

import { expectTypeOf } from "vitest";
import type { RESULT_BAD, RESULT_OK } from "../src/types.ts";

expectTypeOf<typeof RESULT_OK>().toEqualTypeOf<readonly ["success"]>();
expectTypeOf<typeof RESULT_BAD>().toEqualTypeOf<
	readonly ["error_max_turns", "error_during_execution", "error_max_structured_output_retries"]
>();
