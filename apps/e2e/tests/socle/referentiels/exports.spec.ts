/**
 * Exports Excel / PDF des quatre référentiels (`RefLayout` → `downloadExport`, blob + lien
 * `download`). Côté API : `GET /referentials/<ressource>/export?format=xlsx|pdf`, lecture partagée.
 */
import { test, expect } from '../../../fixtures';
import { SCREENS, createRef, dropCreated, exportVia, openRef, type Created } from '../_helpers/referentiels';

const created: Created[] = [];
test.afterEach(async ({ api }) => dropCreated(api, created));

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

for (const screen of Object.values(SCREENS)) {
  test(`SOC-64 export Excel et PDF — ${screen.title}`, async ({ page, api, uniq }) => {
    // Au moins une ligne à exporter, quel que soit l'état du seed.
    const body: Record<string, unknown> = { label: uniq('SOC64 export') };
    if (screen.resource === 'locations' || screen.resource === 'dossiers') body.code = uniq('C64');
    await createRef(api, created, screen, body);

    await openRef(page, screen);
    const xlsx = await exportVia(page, 'Excel');
    expect(xlsx.suggestedFilename()).toBe(`${screen.exportFilename}.xlsx`);
    const pdf = await exportVia(page, 'PDF');
    expect(pdf.suggestedFilename()).toBe(`${screen.exportFilename}.pdf`);
    await expect(page.getByText('Export impossible — réessayez.')).toHaveCount(0);

    // Contenu réel : signature ZIP (xlsx) et en-tête PDF, type MIME annoncé par l'API.
    const resX = await api.raw.get(`/referentials/${screen.resource}/export?format=xlsx`);
    expect(resX.status()).toBe(200);
    expect(resX.headers()['content-type']).toContain(XLSX);
    expect((await resX.body()).subarray(0, 2).toString('latin1')).toBe('PK');
    const resP = await api.raw.get(`/referentials/${screen.resource}/export?format=pdf`);
    expect(resP.status()).toBe(200);
    expect(resP.headers()['content-type']).toContain('application/pdf');
    expect((await resP.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(resP.headers()['content-disposition']).toContain(`${screen.exportFilename}.pdf`);
  });
}
