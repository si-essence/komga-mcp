import { z } from "zod";
import { fixedError } from "./zod-messages.js";

const confirmError = fixedError("confirm must be the boolean true");

/** The only accepted confirm value is the boolean true. false and "true" fail Zod. */
export const confirmField = z
  .literal(true, { error: confirmError })
  .optional()
  .describe(
    "Set to the boolean true to execute the write. Omit this field for a dry-run preview. false and the string true are rejected.",
  );
