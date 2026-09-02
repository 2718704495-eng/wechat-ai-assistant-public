import type {
  AcceptanceReceipt,
  AcceptanceState,
  ReleaseBinding,
} from "./supervised-acceptance.js";
import { hashReleaseBinding } from "./supervised-acceptance.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface RuntimeActivationEvidence {
  readonly report: { readonly hash: string; readonly approvedHash: string | null } | null;
  readonly control: {
    readonly stopped: boolean;
    readonly controlBoundary: { readonly status: "awaiting-boundary" | "active" };
  };
  readonly acceptance: AcceptanceState | null;
}

export interface RuntimeActivationServiceOptions {
  readonly binding: ReleaseBinding;
  readonly prepareReport: () => Promise<{ readonly hash: string }>;
  readonly approveReport: (hash: string) => Promise<void>;
  readonly establishBoundary: () => Promise<unknown>;
  readonly runA: (binding: ReleaseBinding) => Promise<AcceptanceReceipt>;
  readonly runB0: (binding: ReleaseBinding) => Promise<AcceptanceReceipt>;
  readonly runB1: (
    binding: ReleaseBinding,
    decision: "approve" | "abort",
  ) => Promise<AcceptanceReceipt>;
  readonly readEvidence: () => Promise<RuntimeActivationEvidence>;
  readonly readInspectionEvidence?: () => Promise<RuntimeActivationEvidence>;
  readonly readConsentBound?: () => Promise<boolean>;
  readonly runComfortStationAcceptance?: () => Promise<{
    readonly status: "verified" | "already-handled";
    readonly conversationId: "example-contact";
  }>;
  readonly runImageAttachmentQuarantineRecovery?: () => Promise<{
    readonly status: "recovered" | "already-clean";
    readonly archiveName: string;
    readonly composerEmpty: true;
  }>;
  readonly writeConsent: (document: RuntimeConsentDocument) => Promise<void>;
  readonly now?: () => Date;
}

export interface RuntimeConsentDocument {
  readonly version: 1;
  readonly consentConfirmed: true;
  readonly reportHash: string;
  readonly acceptanceBindingSha256: string;
  readonly activatedAt: string;
}

export interface RuntimeActivationInspection {
  readonly bindingSha256: string;
  readonly reportApproved: boolean;
  readonly boundaryActive: boolean;
  readonly aVerified: boolean;
  readonly b0Verified: boolean;
  readonly b1Verified: boolean;
  readonly consentBound: boolean;
}

export class RuntimeActivationService {
  private readonly bindingSha256: string;
  private readonly now: () => Date;

  public constructor(private readonly options: RuntimeActivationServiceOptions) {
    this.bindingSha256 = hashReleaseBinding(options.binding);
    this.now = options.now ?? (() => new Date());
  }

  public prepareReport(): Promise<{ readonly hash: string }> {
    return this.options.prepareReport();
  }

  public approveReport(hash: string): Promise<void> {
    assertSha256(hash, "INITIALIZATION_REPORT_HASH_INVALID");
    return this.options.approveReport(hash);
  }

  public async establishBoundary(): Promise<unknown> {
    const evidence = await this.options.readEvidence();
    if (!isReportApproved(evidence.report)) {
      throw new Error("INITIALIZATION_REPORT_NOT_APPROVED");
    }
    return this.options.establishBoundary();
  }

  public async runA(): Promise<AcceptanceReceipt> {
    await this.assertAcceptancePrerequisites();
    return this.options.runA(this.options.binding);
  }

  public async runB0(): Promise<AcceptanceReceipt> {
    await this.assertAcceptancePrerequisites();
    return this.options.runB0(this.options.binding);
  }

  public async runB1(decision: "approve" | "abort"): Promise<AcceptanceReceipt> {
    await this.assertAcceptancePrerequisites();
    return this.options.runB1(this.options.binding, decision);
  }

  public async finalize(input: {
    readonly decision: "approve" | "abort";
    readonly reportHash: string;
  }): Promise<RuntimeConsentDocument> {
    if (input.decision !== "approve") throw new Error("RUNTIME_ACTIVATION_ABORTED");
    assertSha256(input.reportHash, "INITIALIZATION_REPORT_HASH_INVALID");
    const evidence = await this.options.readEvidence();
    assertFinalizationEvidence(evidence, this.bindingSha256, input.reportHash);
    const activatedAt = this.now().toISOString();
    if (Number.isNaN(new Date(activatedAt).getTime())) {
      throw new Error("RUNTIME_ACTIVATION_TIME_INVALID");
    }
    const document: RuntimeConsentDocument = Object.freeze({
      version: 1,
      consentConfirmed: true,
      reportHash: input.reportHash,
      acceptanceBindingSha256: this.bindingSha256,
      activatedAt,
    });
    await this.options.writeConsent(document);
    return document;
  }

  public async acceptComfortStationCard(): Promise<{
    readonly status: "verified" | "already-handled";
    readonly conversationId: "example-contact";
  }> {
    if (!await (this.options.readConsentBound?.() ?? Promise.resolve(false))) {
      throw new Error("RUNTIME_CONSENT_NOT_BOUND");
    }
    const run = this.options.runComfortStationAcceptance;
    if (run === undefined) throw new Error("COMFORT_STATION_ACCEPTANCE_UNAVAILABLE");
    return run();
  }

  public async recoverImageAttachmentQuarantine(): Promise<{
    readonly status: "recovered" | "already-clean";
    readonly archiveName: string;
    readonly composerEmpty: true;
  }> {
    const inspection = await this.inspect();
    if (!inspection.reportApproved || !inspection.boundaryActive || !inspection.aVerified ||
        !inspection.b0Verified || !inspection.b1Verified || !inspection.consentBound) {
      throw new Error("RUNTIME_ACTIVATION_INCOMPLETE");
    }
    const run = this.options.runImageAttachmentQuarantineRecovery;
    if (run === undefined) throw new Error("WECHAT_IMAGE_ATTACHMENT_RECOVERY_UNAVAILABLE");
    return run();
  }

  public async inspect(): Promise<RuntimeActivationInspection> {
    const evidence = await (this.options.readInspectionEvidence?.() ??
      this.options.readEvidence());
    return {
      bindingSha256: this.bindingSha256,
      reportApproved: isReportApproved(evidence.report),
      boundaryActive: isBoundaryActive(evidence.control),
      aVerified: isVerifiedReceipt(evidence.acceptance?.stages.A, "A", this.bindingSha256),
      b0Verified: isVerifiedReceipt(evidence.acceptance?.stages.B0, "B0", this.bindingSha256),
      b1Verified: isVerifiedReceipt(evidence.acceptance?.stages.B1, "B1", this.bindingSha256),
      consentBound: await (this.options.readConsentBound?.() ?? Promise.resolve(false)),
    };
  }

  private async assertAcceptancePrerequisites(): Promise<void> {
    const evidence = await this.options.readEvidence();
    if (!isReportApproved(evidence.report)) {
      throw new Error("INITIALIZATION_REPORT_NOT_APPROVED");
    }
    if (!isBoundaryActive(evidence.control)) throw new Error("CONTROL_BOUNDARY_REQUIRED");
  }
}

function assertFinalizationEvidence(
  evidence: RuntimeActivationEvidence,
  bindingSha256: string,
  reportHash: string,
): void {
  if (!isReportApproved(evidence.report) || evidence.report?.hash !== reportHash) {
    throw new Error("INITIALIZATION_REPORT_NOT_APPROVED");
  }
  if (!isBoundaryActive(evidence.control)) throw new Error("CONTROL_BOUNDARY_REQUIRED");
  if (evidence.acceptance?.bindingSha256 !== bindingSha256) {
    throw new Error("ACCEPTANCE_BINDING_MISMATCH");
  }
  for (const stage of ["A", "B0", "B1"] as const) {
    if (!isVerifiedReceipt(evidence.acceptance.stages[stage], stage, bindingSha256)) {
      throw new Error("ACCEPTANCE_STAGE_INCOMPLETE");
    }
  }
}

function isReportApproved(
  report: RuntimeActivationEvidence["report"],
): boolean {
  return report !== null && sha256Pattern.test(report.hash) && report.approvedHash === report.hash;
}

function isBoundaryActive(control: RuntimeActivationEvidence["control"]): boolean {
  return !control.stopped && control.controlBoundary.status === "active";
}

function isVerifiedReceipt(
  receipt: AcceptanceReceipt | undefined,
  stage: "A" | "B0" | "B1",
  bindingSha256: string,
): boolean {
  if (receipt === undefined || receipt.stage !== stage || receipt.status !== "verified" ||
      receipt.bindingSha256 !== bindingSha256 || !receipt.closed || !receipt.gateReleased) {
    return false;
  }
  if (stage === "B0") {
    return receipt.target === "example-contact" && receipt.replaceCount === 0 &&
      receipt.submitCount === 0 && receipt.composerEmpty;
  }
  return receipt.target === (stage === "A" ? "file-transfer" : "example-contact") &&
    receipt.replaceCount === 1 && receipt.submitCount === 1 && receipt.draftVerified &&
    receipt.outgoingVerified;
}

function assertSha256(value: string, code: string): void {
  if (!sha256Pattern.test(value)) throw new Error(code);
}
