import { z } from "zod";

import type { EncryptedStore } from "./encrypted-store.js";

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const deliveryRecordSchema = z.object({
  deliveryKey: hex64Schema,
  conversationId: z.literal("example-contact"),
  triggerMessageIdHash: hex64Schema,
  cardSha256: hex64Schema,
  status: z.enum(["intent", "verified", "uncertain"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  visualFingerprintVersion: z.literal("vision-featureprint-v1").nullable(),
}).strict();
const deliveryDocumentSchema = z.object({
  version: z.literal(1),
  deliveries: z.record(hex64Schema, deliveryRecordSchema),
}).strict();

export type ComfortStationDeliveryRecord = z.infer<typeof deliveryRecordSchema>;

export class ComfortStationDeliveryRepository {
  private static readonly documentPath = "state/comfort-station-deliveries.enc";
  private static readonly lockPath = "state/comfort-station-deliveries.lock";

  public constructor(private readonly store: EncryptedStore) {}

  public claim(input: {
    deliveryKey: string;
    triggerMessageIdHash: string;
    cardSha256: string;
    createdAt: string;
  }): Promise<{ claimed: true; record: ComfortStationDeliveryRecord } | {
    claimed: false;
    record: ComfortStationDeliveryRecord;
  }> {
    return this.store.runExclusiveTransaction(
      ComfortStationDeliveryRepository.lockPath,
      async () => {
        const document = await this.load();
        const key = hex64Schema.parse(input.deliveryKey);
        const existing = document.deliveries[key];
        if (existing !== undefined) return { claimed: false as const, record: existing };
        const record = deliveryRecordSchema.parse({
          deliveryKey: key,
          conversationId: "example-contact",
          triggerMessageIdHash: input.triggerMessageIdHash,
          cardSha256: input.cardSha256,
          status: "intent",
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          visualFingerprintVersion: null,
        });
        document.deliveries[key] = record;
        await this.store.write(ComfortStationDeliveryRepository.documentPath, document);
        return { claimed: true as const, record };
      },
    );
  }

  public markVerified(deliveryKey: string, updatedAt: string): Promise<void> {
    return this.update(deliveryKey, "verified", updatedAt, "vision-featureprint-v1");
  }

  public markUncertain(deliveryKey: string, updatedAt: string): Promise<void> {
    return this.update(deliveryKey, "uncertain", updatedAt, null);
  }

  public get(deliveryKey: string): Promise<ComfortStationDeliveryRecord | null> {
    return this.store.runExclusiveTransaction(
      ComfortStationDeliveryRepository.lockPath,
      async () => (await this.load()).deliveries[hex64Schema.parse(deliveryKey)] ?? null,
    );
  }

  private update(
    deliveryKey: string,
    status: "verified" | "uncertain",
    updatedAt: string,
    visualFingerprintVersion: "vision-featureprint-v1" | null,
  ): Promise<void> {
    return this.store.runExclusiveTransaction(
      ComfortStationDeliveryRepository.lockPath,
      async () => {
        const document = await this.load();
        const key = hex64Schema.parse(deliveryKey);
        const current = document.deliveries[key];
        if (current === undefined || current.status !== "intent") {
          throw new Error("COMFORT_STATION_DELIVERY_STATE_INVALID");
        }
        document.deliveries[key] = deliveryRecordSchema.parse({
          ...current,
          status,
          updatedAt,
          visualFingerprintVersion,
        });
        await this.store.write(ComfortStationDeliveryRepository.documentPath, document);
      },
    );
  }

  private async load(): Promise<z.infer<typeof deliveryDocumentSchema>> {
    return (await this.store.read(
      ComfortStationDeliveryRepository.documentPath,
      deliveryDocumentSchema,
    )) ?? { version: 1, deliveries: {} };
  }
}
