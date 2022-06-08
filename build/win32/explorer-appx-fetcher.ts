/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as debug from 'debug';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as product from '../../product.json';
import { downloadArtifact } from '@electron/get';

const d = debug('explorer-appx-fetcher');

export async function downloadExplorerAppx(outDir: string, quality: string = 'stable', targetArch: string = 'x64'): Promise<void> {
	const fileNamePrefix = quality === 'insider' ? 'code_insiders' : 'code';
	const fileName = `${fileNamePrefix}_explorer_${targetArch}.appx`;

	if (await fs.pathExists(path.resolve(outDir, 'fileName'))) {
		return;
	}

	if (!await fs.pathExists(outDir)) {
		await fs.mkdirp(outDir);
	}

	d(`downloading ${fileName}`);
	const artifact = await downloadArtifact({
		isGeneric: true,
		version: '1.0.1',
		artifactName: fileName,
		mirrorOptions: {
			mirror: 'https://github.com/microsoft/vscode-explorer-command/releases/download/',
			customDir: '1.0.1',
			customFilename: fileName
		}
	});

	await fs.copy(artifact, path.join(outDir, fileName));
}

async function main(): Promise<void> {
	const outputDir = process.env['VSCODE_EXPLORER_APPX_DIR'];
	let arch = process.env['VSCODE_ARCH'];

	if (!outputDir) {
		throw new Error('Required build env not set');
	}

	if (arch === 'ia32') {
		arch = 'x86';
	}

	await downloadExplorerAppx(outputDir, (product as any).quality, arch);
}

if (require.main === module) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
