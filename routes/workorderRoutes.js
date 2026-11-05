/* ================================================================
   FRONTEND FIX PATCH — ClientPortal.jsx
   ================================================================
   The bulk-upload bug was primarily on the BACKEND (column-name
   mismatch, ignored client context, hard-coded `origin: 'employee'`,
   5 MB vs 10 MB limit, missing `total` / `workorderIds` in the
   response).  Those are fixed in workorderRoutes.fixed.js.

   On the FRONTEND only two small changes are needed:

   1.  BulkUploadModal.handleUpload — compute `total` from
       `created + failed` when the backend omits it, so the result
       panel always shows an accurate Total count.

   2.  ClientPortal — pass an `onUploadSuccess` callback to
       BulkUploadModal so the dashboard / track-cases list refreshes
       the moment a bulk upload finishes.  Without this the user has
       to manually reload the page to see newly created workorders.

   Apply the two edits below in your existing ClientPortal.jsx.
   Line numbers refer to the file you pasted.
   ================================================================ */


/* ───────────────────────────────────────────────────────────────
   EDIT 1 — inside BulkUploadModal, replace the xhr 'load' handler
   block (around lines 388-418) so the success branch derives
   `total` when the server doesn't send it.
   ─────────────────────────────────────────────────────────────── */

// FIND THIS (lines ~388-402):
//
//   xhr.addEventListener('load', () => {
//       setUploading(false);
//       try {
//           const data = JSON.parse(xhr.responseText);
//           if (xhr.status >= 200 && xhr.status < 300 && data.success) {
//           setUploadResult({
//               success: true,
//               message: data.message || 'Bulk upload completed successfully!',
//               total: data.total ?? data.totalRows ?? 0,
//               created: data.created ?? data.successCount ?? 0,
//               failed: data.failed ?? data.failedCount ?? 0,
//               errors: data.errors ?? data.failedRows ?? [],
//               workorderIds: data.workorderIds ?? [],
//           });
//           if (onUploadSuccess) onUploadSuccess(data);
//
// REPLACE WITH:

        xhr.addEventListener('load', () => {
        setUploading(false);
        try {
            const data = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300 && data.success) {
            const createdCount = data.created ?? data.successCount ?? 0;
            const failedCount  = data.failed  ?? data.failedCount  ?? 0;
            setUploadResult({
                success: true,
                message: data.message || 'Bulk upload completed successfully!',
                // FIX: derive total when backend omits it
                total: data.total ?? data.totalRows ?? (createdCount + failedCount) ?? 0,
                created: createdCount,
                failed: failedCount,
                errors: data.errors ?? data.failedRows ?? [],
                workorderIds: data.workorderIds ?? data.workorders ?? [],
            });
            if (onUploadSuccess) onUploadSuccess(data);
            } else {
            setUploadResult({
                success: false,
                message: data.message || `Server error (${xhr.status})`,
                total: 0, created: 0, failed: 0,
                errors: data.errors || [data.message || `Upload failed (HTTP ${xhr.status})`],
            });
            }
        } catch {
            setUploadResult({
            success: false, message: 'Invalid response from server.',
            total: 0, created: 0, failed: 0,
            errors: ['Could not parse server response. Is the backend running?'],
            });
        }
        });


/* ───────────────────────────────────────────────────────────────
   EDIT 2 — in the main ClientPortal component, add a refresh key
   and pass it as onUploadSuccess so DashboardContent /
   TrackCaseDashboard re-fetch after a bulk upload.

   The DashboardContent and TrackCaseDashboard components already
   own their own fetchData (called via useEffect on mount).  The
   cleanest way to force a re-fetch without restructuring those
   components is to bump a `bulkUploadNonce` counter that we pass
   as `key` to whichever content view is active.  A key change
   unmounts + remounts the child, re-running its useEffect.

   Around line 1598 add the nonce state, and around line 1707
   wire onUploadSuccess.
   ─────────────────────────────────────────────────────────────── */

// FIND THIS (line ~1598):
//
//   // ★ Bulk Upload Modal State ★
//   const [showBulkUploadModal, setShowBulkUploadModal] = useState(false);
//
// REPLACE WITH:

    // ★ Bulk Upload Modal State ★
    const [showBulkUploadModal, setShowBulkUploadModal] = useState(false);
    // ★ bumped after every successful bulk upload so the active
    //   content view (Dashboard / Track Cases) remounts and
    //   re-fetches its workorder list.
    const [bulkUploadNonce, setBulkUploadNonce] = useState(0);

    const handleBulkUploadSuccess = (data) => {
        setBulkUploadNonce(n => n + 1);
        const created = data?.created ?? 0;
        const failed  = data?.failed  ?? 0;
        showToast(
            failed > 0
                ? `Bulk upload done — ${created} created, ${failed} failed.`
                : `Bulk upload done — ${created} workorder${created === 1 ? '' : 's'} created.`,
            failed > 0 ? 'warning' : 'success'
        );
    };

// THEN FIND the renderContent switch (lines ~1659-1680) and add a
// `key` prop to DashboardContent and TrackCaseDashboard so they
// remount when bulkUploadNonce changes:

    const renderContent = () => {
        switch (activeContent) {
        case 'dashboard':
            return <DashboardContent key={`dash-${bulkUploadNonce}`} onNavigate={handleNavigate} clientAuth={clientAuth} />;
        case 'track-cases':
            return <TrackCaseDashboard key={`track-${bulkUploadNonce}`} clientAuth={clientAuth} onNavigate={handleNavigate} />;
        case 'initiate-case':
            return <InitiateCaseForm onBack={() => handleNavigate('back-to-dashboard')} onSubmitted={handleCaseSubmitted} clientAuth={clientAuth} />;
        case 'support-dashboard':
            return <SupportDashboard clientAuth={clientAuth} />;
        case 'fee-approvals':
            return <PlaceholderView title="Fee Approvals" subtitle="Fee approval management will be available soon" icon={FiDollarSign} color="#EC4899" />;
        case 'cards':
            const currentMenu = sidebarMenu.find(m => m.name === activeMenu);
            if (currentMenu?.items?.length > 0) {
            return <CardGridView title={activeMenu} subtitle={currentMenu.items.length + ' options available'} items={currentMenu.items} menuColor={currentMenu.color} onCardClick={handleCardClick} activeCard={activeCard} />;
            }
            return <PlaceholderView title={activeMenu} subtitle="Content coming soon" icon={currentMenu?.icon || FiGrid} color={currentMenu?.color || '#6b7280'} />;
        default:
            return <DashboardContent key={`dash-${bulkUploadNonce}`} onNavigate={handleNavigate} clientAuth={clientAuth} />;
        }
    };

// FINALLY FIND the BulkUploadModal usage (lines ~1707-1711):
//
//   <BulkUploadModal
//       isOpen={showBulkUploadModal}
//       onClose={() => setShowBulkUploadModal(false)}
//       clientAuth={clientAuth}
//   />
//
// REPLACE WITH:

        <BulkUploadModal
            isOpen={showBulkUploadModal}
            onClose={() => setShowBulkUploadModal(false)}
            clientAuth={clientAuth}
            onUploadSuccess={handleBulkUploadSuccess}
        />
