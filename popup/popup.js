// popup.js - OpenAir Timesheet Importer popup

(function () {
  'use strict';

  // Init
  function init() {
    document.getElementById('downloadBtn').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href     = chrome.runtime.getURL('template.xlsx');
      a.download = 'Timesheet template v1.2.xlsx';
      a.click();
    });

    document.getElementById('downloadExampleBtn').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href     = chrome.runtime.getURL('example.xlsx');
      a.download = '7.2026 Example.xlsx';
      a.click();
    });

    // Preferences: "don't show surprise button" toggle (persisted to chrome.storage.sync;
    // the content script reads oai_hide_surprise and omits the button on the completion modal)
    var surprisePref = document.getElementById('oai-surprise-pref');
    if (surprisePref) {
      // "surprise" ON = show the button; default ON. Stored as oai_hide_surprise (the inverse),
      // which the content script reads to hide the button when the user turns this off.
      chrome.storage.sync.get(['oai_hide_surprise'], function (prefs) {
        surprisePref.checked = !prefs.oai_hide_surprise; // unset -> ON by default
      });
      surprisePref.addEventListener('change', function () {
        chrome.storage.sync.set({ oai_hide_surprise: !surprisePref.checked });
      });
    }

    // Preferences: "auto default client:engagement and task" (default ON). When OFF, the
    // content script skips auto-matching and leaves every dropdown on "- leave blank for import -".
    var storedAutoDefault = true; // the user's real "auto-match" choice, remembered while disabled
    var autoDefaultPref = document.getElementById('oai-autodefault-pref');
    if (autoDefaultPref) {
      chrome.storage.sync.get(['oai_auto_default'], function (prefs) {
        storedAutoDefault = prefs.oai_auto_default !== false; // unset -> ON by default
        autoDefaultPref.checked = storedAutoDefault;
        syncAutofillEnabled();
      });
      autoDefaultPref.addEventListener('change', function () {
        storedAutoDefault = autoDefaultPref.checked;
        chrome.storage.sync.set({ oai_auto_default: autoDefaultPref.checked });
      });
    }

    // Preferences: "just fill in time and notes" (default OFF). When ON, the content script
    // shows a read-only review modal and writes ONLY hours + notes, leaving Client:Engagement
    // and Task blank on the timesheet.
    var timeNotesPref = document.getElementById('oai-timenotes-pref');
    // "Autofill Client and Task" only matters in the normal flow. When "Time and Notes only"
    // is ON, Client/Task are left blank, so nothing is autofilled -> grey the nested toggle out.
    function syncAutofillEnabled() {
      if (!autoDefaultPref) return;
      var off = !!(timeNotesPref && timeNotesPref.checked);
      autoDefaultPref.disabled = off;
      // Show it OFF while disabled (auto-match cannot run in fill-time-and-notes-only mode); restore
      // the remembered choice when re-enabled. Setting .checked programmatically does NOT fire the
      // change handler, so the stored oai_auto_default preference is preserved.
      autoDefaultPref.checked = off ? false : storedAutoDefault;
      var row = autoDefaultPref.closest('.oai-pref-row');
      if (row) row.classList.toggle('oai-pref-row--disabled', off);
    }
    if (timeNotesPref) {
      chrome.storage.sync.get(['oai_fill_time_notes_only'], function (prefs) {
        timeNotesPref.checked = !!prefs.oai_fill_time_notes_only; // unset -> OFF by default
        syncAutofillEnabled();
      });
      timeNotesPref.addEventListener('change', function () {
        chrome.storage.sync.set({ oai_fill_time_notes_only: timeNotesPref.checked });
        syncAutofillEnabled();
      });
    }

    // Appearance widget
    OAIAppearance.init(document.getElementById('oai-appearance-widget'));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
