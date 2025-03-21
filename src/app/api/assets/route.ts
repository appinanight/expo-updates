export const runtime = "nodejs";

import fs from 'fs';
import fsPromises from 'fs/promises';
import mime from 'mime';
import nullthrows from 'nullthrows';
import path from 'path';

import {
    getLatestUpdateBundlePathForRuntimeVersionAsync,
    getMetadataAsync,
} from '@/common/helpers';

export async function GET(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const assetName = url.searchParams.get('asset');
    const runtimeVersion = url.searchParams.get('runtimeVersion');
    const platform = url.searchParams.get('platform');

    if (!assetName) {
        return new Response(JSON.stringify({ error: 'No asset name provided.' }), { status: 400 });
    }

    if (platform !== 'ios' && platform !== 'android') {
        return new Response(
            JSON.stringify({ error: 'No platform provided. Expected "ios" or "android".' }),
            { status: 400 }
        );
    }

    if (!runtimeVersion) {
        return new Response(JSON.stringify({ error: 'No runtimeVersion provided.' }), { status: 400 });
    }

    let updateBundlePath: string;
    try {
        updateBundlePath = await getLatestUpdateBundlePathForRuntimeVersionAsync(runtimeVersion);
    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 404 });
    }

    const { metadataJson } = await getMetadataAsync({
        updateBundlePath,
        runtimeVersion,
    });

    const assetPath = path.resolve(assetName);
    const assetMetadata = metadataJson.fileMetadata[platform].assets.find(
        (asset: any) => asset.path === assetName.replace(`${updateBundlePath}/`, '')
    );
    const isLaunchAsset =
        metadataJson.fileMetadata[platform].bundle === assetName.replace(`${updateBundlePath}/`, '');

    if (!fs.existsSync(assetPath)) {
        return new Response(JSON.stringify({ error: `Asset "${assetName}" does not exist.` }), {
            status: 404,
        });
    }

    try {
        const asset = await fsPromises.readFile(assetPath, null);

        return new Response(asset, {
            status: 200,
            headers: {
                'content-type': isLaunchAsset
                    ? 'application/javascript'
                    : nullthrows(mime.getType(assetMetadata.ext)),
            },
        });
    } catch (error) {
        console.error(error);
        return new Response(JSON.stringify({ error: 'Failed to read asset.' }), { status: 500 });
    }
}
