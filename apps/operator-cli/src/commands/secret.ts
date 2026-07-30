export function secretAdmissionDryRun(): {
  operation: "secret.admit";
  status: "disabled";
  reason_code: "ENCRYPTION_REQUIRED";
  ingress: "private_inherited_descriptor";
} {
  return {
    operation: "secret.admit",
    status: "disabled",
    reason_code: "ENCRYPTION_REQUIRED",
    ingress: "private_inherited_descriptor",
  };
}
