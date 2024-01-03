export function compareSemanticVersions(version1: string, version2: string): number {
    const parseVersion = (version: string) => version.split('.').map(Number);

    const v1 = parseVersion(version1);
    const v2 = parseVersion(version2);

    for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
        const num1 = v1[i] || 0;
        const num2 = v2[i] || 0;

        if (num1 > num2) {
            return 1;
        }
        if (num1 < num2) {
            return -1;
        }
    }

    return 0;
}