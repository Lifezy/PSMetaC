# Third-party notices

PSMetaC application source, original icons and the scripts under `vendor/psb_batch_tool`
are distributed under the repository's MIT license. The `vendor` directory is a
versioned snapshot of this project's execution scripts, not Adobe application code.

Build dependencies have their own licenses. They are installed from `pnpm-lock.yaml`
and are not checked into this repository:

- Electron: MIT; Chromium and other bundled components carry additional notices.
- electron-builder: MIT; packaging helpers may carry their own notices.
- @electron/asar: MIT.
- resedit: MIT.

Redistributed application packages must retain the license and notice files supplied
by Electron and its bundled components, including `LICENSE.electron.txt` and
`LICENSES.chromium.html` when present. The application license does not replace them.

The optional Python icon generator uses Pillow, which has its own license; Pillow is
not bundled with the application. Optional UI acceptance scripts use Playwright,
which is not an application dependency.

Adobe and Photoshop are trademarks of Adobe. PSMetaC is an independent project and
does not include, license or distribute Photoshop. Users must supply their own
Photoshop installation.
