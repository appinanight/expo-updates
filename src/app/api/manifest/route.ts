export const runtime = "nodejs";

import FormData from 'form-data';
import fs from 'fs/promises';
import { serializeDictionary } from 'structured-headers';


import {
    convertSHA256HashToUUID,
    convertToDictionaryItemsRepresentation,
    createNoUpdateAvailableDirectiveAsync,
    createRollBackDirectiveAsync,
    getAssetMetadataAsync,
    getExpoConfigAsync,
    getLatestUpdateBundlePathForRuntimeVersionAsync,
    getMetadataAsync,
    getPrivateKeyAsync,
    NoUpdateAvailableError,
    signRSASHA256,
} from '@/common/helpers';

export async function GET(req: Request, res: Response) {
    if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Expected GET.' }), { status: 405 });
    }

    const protocolVersionMaybeArray = req.headers.get('expo-protocol-version');
    if (protocolVersionMaybeArray && Array.isArray(protocolVersionMaybeArray)) {
        return new Response(
            JSON.stringify({ error: 'Unsupported protocol version. Expected either 0 or 1.' }),
            { status: 400 }
        );
    }
    const protocolVersion = parseInt(protocolVersionMaybeArray ?? '0', 10);
    const platform = req.headers.get('expo-platform') ?? new URL(req.url).searchParams.get('platform');
    if (!platform || (platform !== 'ios' && platform !== 'android')) {
        return new Response(
            JSON.stringify({ error: 'Unsupported platform. Expected either ios or android.' }),
            { status: 400 }
        );
    }


    const runtimeVersion =
        req.headers.get('expo-runtime-version') ??
        new URL(req.url).searchParams.get('runtime-version');
    if (!runtimeVersion || typeof runtimeVersion !== 'string') {
        return new Response(JSON.stringify({ error: 'No runtimeVersion provided.' }), { status: 400 });
    }

    let updateBundlePath: string;
    try {
        updateBundlePath = await getLatestUpdateBundlePathForRuntimeVersionAsync(runtimeVersion);
    } catch (error: any) {
        console.log(error.message)
        return new Response(JSON.stringify({ error: error.message }), { status: 404 });
    }


    const updateType = await getTypeOfUpdateAsync(updateBundlePath);

    try {
        if (updateType === UpdateType.NORMAL_UPDATE) {

            const response = await putUpdateInResponseAsync(
                req,
                res,
                updateBundlePath,
                runtimeVersion,
                platform,
                protocolVersion
            );
            return response;
        } else if (updateType === UpdateType.ROLLBACK) {
            const response = await putRollBackInResponseAsync(req, res, updateBundlePath, protocolVersion);
            return response;
        }
    } catch (maybeNoUpdateAvailableError) {
        if (maybeNoUpdateAvailableError instanceof NoUpdateAvailableError) {
            const response = await putNoUpdateAvailableInResponseAsync(req, res, protocolVersion);
            return response;
        }
        console.error(maybeNoUpdateAvailableError);
        const errorMessage = maybeNoUpdateAvailableError instanceof Error
            ? maybeNoUpdateAvailableError.message
            : 'An unknown error occurred';
        return new Response(JSON.stringify({ error: errorMessage }), {
            status: 404,
        });
    }
}

enum UpdateType {
    NORMAL_UPDATE,
    ROLLBACK,
}

async function getTypeOfUpdateAsync(updateBundlePath: string): Promise<UpdateType> {
    const directoryContents = await fs.readdir(updateBundlePath);
    return directoryContents.includes('rollback') ? UpdateType.ROLLBACK : UpdateType.NORMAL_UPDATE;
}

async function putUpdateInResponseAsync(
    req: Request,
    res: Response,
    updateBundlePath: string,
    runtimeVersion: string,
    platform: string,
    protocolVersion: number
): Promise<Response> {
    const currentUpdateId = req.headers.get('expo-current-update-id');
    const { metadataJson, createdAt, id } = await getMetadataAsync({
        updateBundlePath,
        runtimeVersion,
    });

    if (currentUpdateId === convertSHA256HashToUUID(id) && protocolVersion === 1) {
        return new Response(JSON.stringify({ message: 'No update available' }), { status: 200 });
    }

    const expoConfig = await getExpoConfigAsync({
        updateBundlePath,
        runtimeVersion,
    });
    const platformSpecificMetadata = metadataJson.fileMetadata[platform];
    const manifest = {
        id: convertSHA256HashToUUID(id),
        createdAt,
        runtimeVersion,
        assets: await Promise.all(
            (platformSpecificMetadata.assets as any[]).map((asset: any) =>
                getAssetMetadataAsync({
                    updateBundlePath,
                    filePath: asset.path,
                    ext: asset.ext,
                    runtimeVersion,
                    platform,
                    isLaunchAsset: false,
                })
            )
        ),
        launchAsset: await getAssetMetadataAsync({
            updateBundlePath,
            filePath: platformSpecificMetadata.bundle,
            isLaunchAsset: true,
            runtimeVersion,
            platform,
            ext: null,
        }),
        metadata: {},
        extra: {
            expoClient: expoConfig,
        },
    };

    let signature = null;
    const expectSignatureHeader = req.headers.get('expo-expect-signature');
    if (expectSignatureHeader) {
        const privateKey = await getPrivateKeyAsync();
        if (!privateKey) {
            return new Response(
                JSON.stringify({ error: 'Code signing requested but no key supplied when starting server.' }),
                { status: 400, headers: { 'content-type': 'application/json' } }
            );
        }
        const manifestString = JSON.stringify(manifest);
        const hashSignature = signRSASHA256(manifestString, privateKey);
        const dictionary = convertToDictionaryItemsRepresentation({
            sig: hashSignature,
            keyid: 'main',
        });
        signature = serializeDictionary(dictionary);
    }

    const assetRequestHeaders: { [key: string]: object } = {};
    [...manifest.assets, manifest.launchAsset].forEach((asset) => {
        assetRequestHeaders[asset.key] = {
            'test-header': 'test-header-value',
        };
    });

    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest), {
        contentType: 'application/json',
        header: {
            'content-type': 'application/json; charset=utf-8',
            ...(signature ? { 'expo-signature': signature } : {}),
        },
    });
    form.append('extensions', JSON.stringify({ assetRequestHeaders }), {
        contentType: 'application/json',
    });

    return new Response(form.getBuffer(), {
        status: 200,
        headers: {
            'expo-protocol-version': protocolVersion.toString(),
            'expo-sfv-version': '0',
            'cache-control': 'private, max-age=0',
            'content-type': `multipart/mixed; boundary=${form.getBoundary()}`,
        },
    });
}

async function putRollBackInResponseAsync(
    req: Request,
    res: Response,
    updateBundlePath: string,
    protocolVersion: number
): Promise<Response> {
    if (protocolVersion === 0) {
        throw new Error('Rollbacks not supported on protocol version 0');
    }

    const embeddedUpdateId = req.headers.get('expo-embedded-update-id');
    if (!embeddedUpdateId || typeof embeddedUpdateId !== 'string') {
        throw new Error('Invalid Expo-Embedded-Update-ID request header specified.');
    }

    const currentUpdateId = req.headers.get('expo-current-update-id');
    if (currentUpdateId === embeddedUpdateId) {
        throw new NoUpdateAvailableError();
    }

    const directive = await createRollBackDirectiveAsync(updateBundlePath);

    let signature = null;
    const expectSignatureHeader = req.headers.get('expo-expect-signature');
    if (expectSignatureHeader) {
        const privateKey = await getPrivateKeyAsync();
        if (!privateKey) {
            return new Response(
                JSON.stringify({ error: 'Code signing requested but no key supplied when starting server.' }),
                { status: 400, headers: { 'content-type': 'application/json' } }
            );
        }
        const directiveString = JSON.stringify(directive);
        const hashSignature = signRSASHA256(directiveString, privateKey);
        const dictionary = convertToDictionaryItemsRepresentation({
            sig: hashSignature,
            keyid: 'main',
        });
        signature = serializeDictionary(dictionary);
    }

    const form = new FormData();
    form.append('directive', JSON.stringify(directive), {
        contentType: 'application/json',
        header: {
            'content-type': 'application/json; charset=utf-8',
            ...(signature ? { 'expo-signature': signature } : {}),
        },
    });

    return new Response(form.getBuffer(), {
        status: 200,
        headers: {
            'expo-protocol-version': '1',
            'expo-sfv-version': '0',
            'cache-control': 'private, max-age=0',
            'content-type': `multipart/mixed; boundary=${form.getBoundary()}`,
        },
    });
}

async function putNoUpdateAvailableInResponseAsync(
    req: Request,
    res: Response,
    protocolVersion: number
): Promise<Response> {
    if (protocolVersion === 0) {
        throw new Error('NoUpdateAvailable directive not available in protocol version 0');
    }

    const directive = await createNoUpdateAvailableDirectiveAsync();

    let signature = null;
    const expectSignatureHeader = req.headers.get('expo-expect-signature');
    if (expectSignatureHeader) {
        const privateKey = await getPrivateKeyAsync();
        if (!privateKey) {
            return new Response(
                JSON.stringify({ error: 'Code signing requested but no key supplied when starting server.' }),
                { status: 400, headers: { 'content-type': 'application/json' } }
            );
        }
        const directiveString = JSON.stringify(directive);
        const hashSignature = signRSASHA256(directiveString, privateKey);
        const dictionary = convertToDictionaryItemsRepresentation({
            sig: hashSignature,
            keyid: 'main',
        });
        signature = serializeDictionary(dictionary);
    }

    const form = new FormData();
    form.append('directive', JSON.stringify(directive), {
        contentType: 'application/json',
        header: {
            'content-type': 'application/json; charset=utf-8',
            ...(signature ? { 'expo-signature': signature } : {}),
        },
    });

    return new Response(form.getBuffer(), {
        status: 200,
        headers: {
            'expo-protocol-version': '1',
            'expo-sfv-version': '0',
            'cache-control': 'private, max-age=0',
            'content-type': `multipart/mixed; boundary=${form.getBoundary()}`,
        },
    });
}
