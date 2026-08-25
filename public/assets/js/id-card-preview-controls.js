// Controls for the standalone ID-card preview page (buildIdCardHtml in
// server.js, served by GET /api/registrar/documents/id-card/:student_id/preview).
// This used to be two inline onclick="..." attributes on the Flip Card and
// Print buttons, but that page is served through the same global helmet()
// CSP as the rest of the app, and script-src-attr blocks inline handlers
// there just as it does in the main SPA — so this needed the same fix:
// pulled out into an external file and wired up with addEventListener.
document.addEventListener('DOMContentLoaded', () => {
    const flipBtn = document.getElementById('id-card-flip-btn');
    const printBtn = document.getElementById('id-card-print-btn');

    if (flipBtn) {
        flipBtn.addEventListener('click', () => {
            const front = document.querySelector('.id-card-front');
            const back = document.querySelector('.id-card-back');
            if (!front || !back) return;
            const showFront = front.style.display !== 'none';
            front.style.display = showFront ? 'none' : 'block';
            back.style.display = showFront ? 'block' : 'none';
        });
    }

    if (printBtn) {
        printBtn.addEventListener('click', () => window.print());
    }
});
