import { ExpoUpdatesManifest } from '@expo/config';
import { Updates } from '@expo/config-plugins';
import accepts from 'accepts';
import crypto from 'crypto';
import { serializeDictionary, Dictionary } from 'structured-headers';

import { ManifestMiddleware, ManifestRequestInfo } from './ManifestMiddleware';
import { assertRuntimePlatform, parsePlatformHeader } from './resolvePlatform';
import { resolveRuntimeVersionWithExpoUpdatesAsync } from './resolveRuntimeVersionWithExpoUpdatesAsync';
import { ServerHeaders, ServerRequest } from './server.types';
import { getAnonymousIdAsync } from '../../../api/user/UserSettings';
import { ANONYMOUS_USERNAME } from '../../../api/user/user';
import {
  CodeSigningInfo,
  getCodeSigningInfoAsync,
  signManifestString,
} from '../../../utils/codesigning';
import { CommandError } from '../../../utils/errors';
import {
  encodeMultipartMixed,
  FormDataField,
  EncodedFormData,
} from '../../../utils/multipartMixed';
import { stripPort } from '../../../utils/url';

const debug = require('debug')('expo:start:server:middleware:ExpoGoManifestHandlerMiddleware');

export enum ResponseContentType {
  TEXT_PLAIN,
  APPLICATION_JSON,
  APPLICATION_EXPO_JSON,
  MULTIPART_MIXED,
}

interface ExpoGoManifestRequestInfo extends ManifestRequestInfo {
  responseContentType: ResponseContentType;
  expectSignature: string | null;
}

export class ExpoGoManifestHandlerMiddleware extends ManifestMiddleware<ExpoGoManifestRequestInfo> {
  public getParsedHeaders(req: ServerRequest): ExpoGoManifestRequestInfo {
    let platform = parsePlatformHeader(req);

    if (!platform) {
      debug(
        `No "expo-platform" header or "platform" query parameter specified. Falling back to "ios".`
      );
      platform = 'ios';
    }

    assertRuntimePlatform(platform);

    // Expo Updates clients explicitly accept "multipart/mixed" responses while browsers implicitly
    // accept them with "accept: */*". To make it easier to debug manifest responses by visiting their
    // URLs in a browser, we denote the response as "text/plain" if the user agent appears not to be
    // an Expo Updates client.
    const accept = accepts(req);
    const acceptedType = accept.types([
      'unknown/unknown',
      'multipart/mixed',
      'application/json',
      'application/expo+json',
      'text/plain',
    ]);

    let responseContentType;
    switch (acceptedType) {
      case 'multipart/mixed':
        responseContentType = ResponseContentType.MULTIPART_MIXED;
        break;
      case 'application/json':
        responseContentType = ResponseContentType.APPLICATION_JSON;
        break;
      case 'application/expo+json':
        responseContentType = ResponseContentType.APPLICATION_EXPO_JSON;
        break;
      default:
        responseContentType = ResponseContentType.TEXT_PLAIN;
        break;
    }

    const expectSignature = req.headers['expo-expect-signature'];

    return {
      responseContentType,
      platform,
      expectSignature: expectSignature ? String(expectSignature) : null,
      hostname: stripPort(req.headers['host']),
      protocol: req.headers['x-forwarded-proto'] as 'http' | 'https' | undefined,
    };
  }

  private getDefaultResponseHeaders(): ServerHeaders {
    const headers = new Map<string, number | string | readonly string[]>();
    // set required headers for Expo Updates manifest specification
    headers.set('expo-protocol-version', 0);
    headers.set('expo-sfv-version', 0);
    headers.set('cache-control', 'private, max-age=0');
    return headers;
  }

  public async _getManifestResponseAsync(requestOptions: ExpoGoManifestRequestInfo): Promise<{
    body: string;
    version: string;
    headers: ServerHeaders;
  }> {
    const { exp, hostUri, expoGoConfig, bundleUrl } =
      await this._resolveProjectSettingsAsync(requestOptions);

    const runtimeVersion =
      (await resolveRuntimeVersionWithExpoUpdatesAsync({
        projectRoot: this.projectRoot,
        platform: requestOptions.platform,
      })) ??
      // if expo-updates can't determine runtime version, fall back to calculation from config-plugin.
      // this happens when expo-updates is installed but runtimeVersion hasn't yet been configured or when
      // expo-updates is not installed.
      (await Updates.getRuntimeVersionAsync(
        this.projectRoot,
        { ...exp, runtimeVersion: exp.runtimeVersion ?? { policy: 'sdkVersion' } },
        requestOptions.platform
      ));
    if (!runtimeVersion) {
      throw new CommandError(
        'MANIFEST_MIDDLEWARE',
        `Unable to determine runtime version for platform '${requestOptions.platform}'`
      );
    }

    const codeSigningInfo = await getCodeSigningInfoAsync(
      exp,
      requestOptions.expectSignature,
      this.options.privateKeyPath
    );

    const easProjectId = exp.extra?.eas?.projectId as string | undefined | null;
    const scopeKey = await ExpoGoManifestHandlerMiddleware.getScopeKeyAsync({
      slug: exp.slug,
      codeSigningInfo,
    });

    const expoUpdatesManifest: ExpoUpdatesManifest = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      runtimeVersion,
      launchAsset: {
        key: 'bundle',
        contentType: 'application/javascript',
        url: bundleUrl,
      },
      assets: [], // assets are not used in development
      metadata: {}, // required for the client to detect that this is an expo-updates manifest
      extra: {
        eas: {
          projectId: easProjectId ?? undefined,
        },
        expoClient: {
          ...exp,
          hostUri,
        },
        expoGo: expoGoConfig,
        scopeKey,
      },
    };

    const stringifiedManifest = JSON.stringify(expoUpdatesManifest);

    let manifestPartHeaders: { 'expo-signature': string } | null = null;
    let certificateChainBody: string | null = null;
    if (codeSigningInfo) {
      const signature = signManifestString(stringifiedManifest, codeSigningInfo);
      manifestPartHeaders = {
        'expo-signature': serializeDictionary(
          convertToDictionaryItemsRepresentation({
            keyid: codeSigningInfo.keyId,
            sig: signature,
            alg: 'rsa-v1_5-sha256',
          })
        ),
      };
      certificateChainBody = codeSigningInfo.certificateChainForResponse.join('\n');
    }

    const headers = this.getDefaultResponseHeaders();

    switch (requestOptions.responseContentType) {
      case ResponseContentType.MULTIPART_MIXED: {
        const encoded = await this.encodeFormDataAsync({
          stringifiedManifest,
          manifestPartHeaders,
          certificateChainBody,
        });
        headers.set('content-type', `multipart/mixed; boundary=${encoded.boundary}`);
        return {
          body: encoded.body,
          version: runtimeVersion,
          headers,
        };
      }
      case ResponseContentType.APPLICATION_EXPO_JSON:
      case ResponseContentType.APPLICATION_JSON:
      case ResponseContentType.TEXT_PLAIN: {
        headers.set(
          'content-type',
          ExpoGoManifestHandlerMiddleware.getContentTypeForResponseContentType(
            requestOptions.responseContentType
          )
        );
        if (manifestPartHeaders) {
          Object.entries(manifestPartHeaders).forEach(([key, value]) => {
            headers.set(key, value);
          });
        }

        return {
          body: stringifiedManifest,
          version: runtimeVersion,
          headers,
        };
      }
    }
  }

  private static getContentTypeForResponseContentType(
    responseContentType: ResponseContentType
  ): string {
    switch (responseContentType) {
      case ResponseContentType.MULTIPART_MIXED:
        return 'multipart/mixed';
      case ResponseContentType.APPLICATION_EXPO_JSON:
        return 'application/expo+json';
      case ResponseContentType.APPLICATION_JSON:
        return 'application/json';
      case ResponseContentType.TEXT_PLAIN:
        return 'text/plain';
    }
  }

  private encodeFormDataAsync({
    stringifiedManifest,
    manifestPartHeaders,
    certificateChainBody,
  }: {
    stringifiedManifest: string;
    manifestPartHeaders: { 'expo-signature': string } | null;
    certificateChainBody: string | null;
  }): Promise<EncodedFormData> {
    const fields: FormDataField[] = [
      {
        name: 'manifest',
        value: stringifiedManifest,
        contentType: 'application/json',
        partHeaders: manifestPartHeaders,
      },
    ];
    if (certificateChainBody && certificateChainBody.length > 0) {
      fields.push({
        name: 'certificate_chain',
        value: certificateChainBody,
        contentType: 'application/x-pem-file',
      });
    }
    return encodeMultipartMixed(fields);
  }

  private static async getScopeKeyAsync({
    slug,
    codeSigningInfo,
  }: {
    slug: string;
    codeSigningInfo: CodeSigningInfo | null;
  }): Promise<string> {
    const scopeKeyFromCodeSigningInfo = codeSigningInfo?.scopeKey;
    if (scopeKeyFromCodeSigningInfo) {
      return scopeKeyFromCodeSigningInfo;
    }

    // Log.warn(
    //   env.EXPO_OFFLINE
    //     ? 'Using anonymous scope key in manifest for offline mode.'
    //     : 'Using anonymous scope key in manifest.'
    // );
    return await getAnonymousScopeKeyAsync(slug);
  }
}

async function getAnonymousScopeKeyAsync(slug: string): Promise<string> {
  const userAnonymousIdentifier = await getAnonymousIdAsync();
  return `@${ANONYMOUS_USERNAME}/${slug}-${userAnonymousIdentifier}`;
}

function convertToDictionaryItemsRepresentation(obj: { [key: string]: string }): Dictionary {
  return new Map(
    Object.entries(obj).map(([k, v]) => {
      return [k, [v, new Map()]];
    })
  );
}
