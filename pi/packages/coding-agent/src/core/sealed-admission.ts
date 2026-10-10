/** sealed: when PI_ADMITTED_HOSTS is set (by bin/sealed), every provider or model baseUrl must be on an admitted host. */
export function assertAdmittedBaseUrl(baseUrl: string | undefined, what: string): void {
	const admitted = process.env.PI_ADMITTED_HOSTS;
	if (admitted === undefined || baseUrl === undefined) return;
	const host = new URL(baseUrl).hostname;
	if (!admitted.split(",").includes(host)) {
		throw new Error(`✗ refused: ${what} baseUrl ${baseUrl} is not an admitted host (providers.json)`);
	}
}
