import { $transaction, PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import {
  RegisterSourceEvent,
  RegisterTriggerBody,
} from "@trigger.dev/internal";
import { RegisterSourceService } from "../sources/registerSource.server";
import {
  SecretStore,
  SecretStoreProvider,
  getSecretStore,
} from "../secrets/secretStore.server";
import { z } from "zod";
import { env } from "~/env.server";

export class RegisterTriggerSourceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    payload,
    endpointSlug,
    id,
    key,
  }: {
    environment: AuthenticatedEnvironment;
    payload: RegisterTriggerBody;
    id: string;
    endpointSlug: string;
    key: string;
  }): Promise<RegisterSourceEvent> {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: endpointSlug,
        },
      },
    });

    const dynamicTrigger =
      await this.#prismaClient.dynamicTrigger.findUniqueOrThrow({
        where: {
          endpointId_slug: {
            endpointId: endpoint.id,
            slug: id,
          },
        },
      });

    return await $transaction(this.#prismaClient, async (tx) => {
      const service = new RegisterSourceService(tx);

      const triggerSource = await service.call(
        endpoint.id,
        payload.source,
        dynamicTrigger.id
      );

      const eventDispatcher = await tx.eventDispatcher.upsert({
        where: {
          dispatchableId_environmentId: {
            dispatchableId: triggerSource.id,
            environmentId: environment.id,
          },
        },
        create: {
          dispatchableId: triggerSource.id,
          environmentId: environment.id,
          event: payload.rule.event,
          source: payload.rule.source,
          payloadFilter: payload.rule.payload,
          contextFilter: payload.rule.context,
          dispatchable: {
            type: "DYNAMIC_TRIGGER",
            id: dynamicTrigger.id,
          },
        },
        update: {
          event: payload.rule.event,
          source: payload.rule.source,
          payloadFilter: payload.rule.payload,
          contextFilter: payload.rule.context,
          dispatchable: {
            type: "DYNAMIC_TRIGGER",
            id: dynamicTrigger.id,
          },
        },
      });

      const registration = await tx.dynamicTriggerRegistration.upsert({
        where: {
          key_dynamicTriggerId: {
            key,
            dynamicTriggerId: dynamicTrigger.id,
          },
        },
        create: {
          key,
          dynamicTriggerId: dynamicTrigger.id,
          sourceId: triggerSource.id,
          eventDispatcherId: eventDispatcher.id,
        },
        update: {},
      });

      const secretStore = getSecretStore(
        triggerSource.secretReference.provider,
        { prismaClient: tx }
      );

      const { secret } = await secretStore.getSecretOrThrow(
        z.object({
          secret: z.string(),
        }),
        triggerSource.secretReference.key
      );

      return {
        id: registration.id,
        source: {
          key: triggerSource.key,
          active: triggerSource.active,
          params: triggerSource.params,
          secret,
          data: triggerSource.channelData as any,
          channel: {
            type: "HTTP",
            url: `${env.APP_ORIGIN}/api/v1/sources/http/${triggerSource.id}`,
          },
          clientId: triggerSource.apiClient?.slug,
        },
        events: triggerSource.events.map((e) => e.name),
        missingEvents: [],
        orphanedEvents: [],
      };
    });
  }
}