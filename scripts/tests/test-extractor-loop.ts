import test from 'node:test';
import assert from 'node:assert';

test('rate-limiting loop pauses after 10 items', async () => {
    let sleepCount = 0;
    let sleepDuration = 0;

    const mockSleep = (ms: number) => {
        sleepCount++;
        sleepDuration = ms;
        return Promise.resolve();
    };

    const processItems = async (items: any[], mockProcess: (item: any) => Promise<void>) => {
        let processedCount = 0;
        for (let i = 0; i < items.length; i++) {
            await mockProcess(items[i]);
            processedCount++;
            if (processedCount % 10 === 0 && processedCount < items.length) {
                await mockSleep(65000);
            }
        }
    };

    const items = Array.from({ length: 25 }, (_, i) => i);
    let processedItems = 0;

    await processItems(items, async () => {
        processedItems++;
        return Promise.resolve();
    });

    assert.strictEqual(processedItems, 25, 'All items should be processed');
    assert.strictEqual(sleepCount, 2, 'Should have slept twice for 25 items');
    assert.strictEqual(sleepDuration, 65000, 'Should sleep for 65 seconds');
});

test('PDF downloader handles errors and large files gracefully', async () => {
    const mockFetch = async (url: string): Promise<{ ok: boolean, status: number, arrayBuffer: () => Promise<ArrayBuffer>, headers: Headers }> => {
        if (url === '404-url') {
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: new Headers() };
        }
        if (url === '403-url') {
            return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0), headers: new Headers() };
        }
        if (url === 'large-file-url') {
            const headers = new Headers();
            headers.set('content-length', (16 * 1024 * 1024).toString()); // 16MB
            return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), headers };
        }
        if (url === 'timeout-url') {
            throw new Error('fetch failed'); // Simulate timeout/network error
        }
        if (url === 'success-url') {
            const headers = new Headers();
            headers.set('content-length', (1 * 1024 * 1024).toString()); // 1MB
            return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), headers };
        }
        return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0), headers: new Headers() };
    };

    const downloadPdf = async (url: string): Promise<{ success: boolean, data?: ArrayBuffer, error?: string, skip?: boolean }> => {
        try {
            const response = await mockFetch(url);
            if (!response.ok) {
                return { success: false, error: `HTTP Error: ${response.status}` };
            }

            const contentLength = response.headers.get('content-length');
            if (contentLength && parseInt(contentLength, 10) > 15 * 1024 * 1024) {
                return { success: false, skip: true, error: 'File too large (> 15MB)' };
            }

            const data = await response.arrayBuffer();
            return { success: true, data };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    };

    // Test 404
    let res = await downloadPdf('404-url');
    assert.strictEqual(res.success, false);
    assert.ok(res.error?.includes('404'));

    // Test 403
    res = await downloadPdf('403-url');
    assert.strictEqual(res.success, false);
    assert.ok(res.error?.includes('403'));

    // Test large file
    res = await downloadPdf('large-file-url');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.skip, true);

    // Test timeout/network error
    res = await downloadPdf('timeout-url');
    assert.strictEqual(res.success, false);
    assert.ok(res.error?.includes('fetch failed'));

    // Test success
    res = await downloadPdf('success-url');
    assert.strictEqual(res.success, true);
    assert.ok(res.data !== undefined);
});
