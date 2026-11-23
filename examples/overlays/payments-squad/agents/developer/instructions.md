<!-- Team instructions for the Developer agent (payments-squad). Changes go through MRs on the workspace repo. -->
- Money is always `BigDecimal` with scale 2 and `RoundingMode.HALF_EVEN`; never `double`.
- New REST endpoints follow the existing `/api/v1/...` controllers in `billing-api`; reuse `ApiError` for errors.
- Run `mvn -q verify` before you finish; the MR pipeline runs the same.
