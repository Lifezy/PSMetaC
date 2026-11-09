#target photoshop

(function (jobPathArgument) {
    function trimJobText(value) {
        return String(value || "").replace(/^\s+|\s+$/g, "");
    }

    function decodeJobText(value) {
        try {
            return decodeURIComponent(value);
        } catch (ignoredDecode) {
            return value;
        }
    }

    function loadJob(jobPath) {
        if (!jobPath) {
            throw new Error("Missing PSB metadata cleaner job path");
        }
        var jobFile = new File(String(jobPath));
        if (!jobFile.exists) {
            throw new Error("Job file does not exist: " + jobPath);
        }
        jobFile.encoding = "UTF8";
        if (!jobFile.open("r")) {
            throw new Error("Cannot open job file: " + jobPath);
        }
        var raw = jobFile.read();
        jobFile.close();
        var lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        if (
            lines.length === 0 ||
            trimJobText(lines[0]) !== "#PSB_METADATA_CLEANER_JOB_V1"
        ) {
            throw new Error("Unsupported or invalid job header");
        }
        var values = {};
        var i;
        for (i = 1; i < lines.length; i++) {
            if (!lines[i]) {
                continue;
            }
            var fields = lines[i].split("\t");
            values[fields[0]] = decodeJobText(fields.slice(1).join("\t"));
        }
        var required = ["SOURCE_PATH", "ARTIFACT_DIR"];
        for (i = 0; i < required.length; i++) {
            if (!values[required[i]]) {
                throw new Error("Job is missing " + required[i]);
            }
        }
        if (
            values.EXECUTION_MODE !== "in_place" &&
            !values.OUTPUT_PATH
        ) {
            throw new Error("Job is missing OUTPUT_PATH");
        }
        return values;
    }

    var job = loadJob(jobPathArgument);
    var sourcePath = job.SOURCE_PATH;
    var outputPath = job.OUTPUT_PATH;
    var artifactDirPath = job.ARTIFACT_DIR;
    var executionMode = job.EXECUTION_MODE || "safe_copy";
    var inPlace = executionMode === "in_place";
    var coveragePolicy = job.COVERAGE_POLICY || "strict";
    var coverageThresholdPercent = Number(
        job.COVERAGE_THRESHOLD_PERCENT || "5"
    );
    var reopenRequired = job.REOPEN_REQUIRED !== "false";
    var deleteHiddenLayers = job.DELETE_HIDDEN_LAYERS === "true";
    var deleteEmptyLayers = job.DELETE_EMPTY_LAYERS === "true";
    if (inPlace && (deleteHiddenLayers || deleteEmptyLayers)) {
        throw new Error(
            "Layer deletion is only allowed in safe-copy mode"
        );
    }
    var cleanupPlanPath = artifactDirPath + "\\cleanup_plan.tsv";
    var beforePreviewPath = artifactDirPath + "\\before.png";
    var afterProcessingPreviewPath = artifactDirPath + "\\after_processing.png";
    var afterSavePreviewPath = artifactDirPath + "\\after_save.png";
    var afterReopenPreviewPath = artifactDirPath + "\\after_reopen.png";
    var logPath = artifactDirPath + "\\photoshop.log";
    var cancelFlagPath = artifactDirPath + "\\CANCEL.flag";
    var auditOnlyFlagPath = artifactDirPath + "\\AUDIT_IDS_ONLY.flag";
    var cancelSentinel = "__PSB_CANCEL_REQUESTED__";
    var runStartMs = new Date().getTime();

    var artifactDir = new Folder(artifactDirPath);
    if (!artifactDir.exists) {
        artifactDir.create();
    }

    var oldLog = new File(logPath);
    if (oldLog.exists) {
        oldLog.remove();
    }

    function logLine(message) {
        var file = new File(logPath);
        file.encoding = "UTF8";
        file.open("a");
        file.writeln(new Date().toUTCString() + "\t" + message);
        file.close();
    }

    function elapsedMs() {
        return new Date().getTime() - runStartMs;
    }

    function isCancellationError(error) {
        if (!error) {
            return false;
        }
        var message = String(error.message || error);
        var number = null;
        try {
            number = error.number;
        } catch (ignoredErrorNumber) {
        }
        return (
            message.indexOf(cancelSentinel) >= 0 ||
            /cancel|取消/i.test(message) ||
            number === 8007
        );
    }

    function checkCancellation(label) {
        var flag = new File(cancelFlagPath);
        if (flag.exists) {
            logLine(
                "CANCEL\tREQUESTED\t" + label +
                "\telapsedMs=" + elapsedMs()
            );
            throw new Error(cancelSentinel + " " + label);
        }
    }

    function trimText(value) {
        return String(value || "").replace(/^\s+|\s+$/g, "");
    }

    function normalizeAssetId(value) {
        var text = trimText(value).toLowerCase();
        var dashed = text.match(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
        );
        if (dashed) {
            return dashed[0];
        }
        var compact = text.match(/[0-9a-f]{32}/);
        if (!compact) {
            return "";
        }
        text = compact[0];
        return (
            text.substring(0, 8) + "-" +
            text.substring(8, 12) + "-" +
            text.substring(12, 16) + "-" +
            text.substring(16, 20) + "-" +
            text.substring(20)
        );
    }

    function normalizeFileName(value) {
        var text = trimText(value).replace(/\//g, "\\");
        var slash = text.lastIndexOf("\\");
        if (slash >= 0) {
            text = text.substring(slash + 1);
        }
        return text.toLowerCase();
    }

    function decodePlanText(value) {
        try {
            return decodeURIComponent(value);
        } catch (ignoredDecode) {
            return value;
        }
    }

    function loadCleanupPlan(planPath, sourceFile) {
        var planFile = new File(planPath);
        if (!planFile.exists) {
            throw new Error("Cleanup plan does not exist: " + planPath);
        }
        planFile.encoding = "UTF8";
        if (!planFile.open("r")) {
            throw new Error("Cannot open cleanup plan: " + planPath);
        }
        var raw = planFile.read();
        planFile.close();

        var lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        var planHeader = lines.length > 0 ? trimText(lines[0]) : "";
        if (
            planHeader !== "#PSB_CLEANUP_PLAN_V1" &&
            planHeader !== "#PSB_CLEANUP_PLAN_V2"
        ) {
            throw new Error("Unsupported or invalid cleanup plan header");
        }

        var plan = {
            version: planHeader === "#PSB_CLEANUP_PLAN_V2" ? 2 : 1,
            sourcePath: "",
            sourceBytes: null,
            sourceMtimeMs: null,
            rootCleanSelf: false,
            rootDepthBits: null,
            anomalousContainers: 0,
            anomalousEmbeddedContainers: 0,
            recordsRequiredToOpen: 0,
            targetRecords: 0,
            ancestorOnlyRecords: 0,
            crossBitDepthRecords: 0,
            openIds: {},
            openNames: {},
            openRecords: [],
            uniqueAssetRecords: 0,
            duplicateAssetGroups: 0,
            recordCount: 0
        };

        var i;
        for (i = 1; i < lines.length; i++) {
            var line = lines[i];
            if (!line) {
                continue;
            }
            var fields = line.split("\t");
            var key = fields[0];
            if (key === "SOURCE_PATH") {
                plan.sourcePath = decodePlanText(fields[1] || "");
            } else if (key === "SOURCE_BYTES") {
                plan.sourceBytes = Number(fields[1]);
            } else if (key === "SOURCE_MTIME_MS") {
                plan.sourceMtimeMs = Number(fields[1]);
            } else if (key === "ROOT_CLEAN_SELF") {
                plan.rootCleanSelf = fields[1] === "1";
            } else if (key === "ROOT_DEPTH_BITS") {
                plan.rootDepthBits = Number(fields[1]);
            } else if (key === "ANOMALOUS_CONTAINERS") {
                plan.anomalousContainers = Number(fields[1]);
            } else if (key === "ANOMALOUS_EMBEDDED_CONTAINERS") {
                plan.anomalousEmbeddedContainers = Number(fields[1]);
            } else if (key === "RECORDS_REQUIRED_TO_OPEN") {
                plan.recordsRequiredToOpen = Number(fields[1]);
            } else if (key === "TARGET_RECORDS") {
                plan.targetRecords = Number(fields[1]);
            } else if (key === "ANCESTOR_ONLY_RECORDS") {
                plan.ancestorOnlyRecords = Number(fields[1]);
            } else if (key === "CROSS_BIT_DEPTH_RECORDS") {
                plan.crossBitDepthRecords = Number(fields[1]);
            } else if (key === "OPEN") {
                var assetId = normalizeAssetId(fields[1] || "");
                if (!assetId) {
                    throw new Error(
                        "Cleanup plan contains invalid asset ID at line " +
                        (i + 1)
                    );
                }
                if (
                    plan.version === 1 &&
                    plan.openIds[assetId] !== undefined
                ) {
                    throw new Error(
                        "Cleanup plan contains duplicate asset ID: " + assetId
                    );
                }
                var containerId = fields[9] || "";
                var parentContainerId = fields[10] || "";
                if (!parentContainerId && containerId) {
                    var separatorIndex = containerId.lastIndexOf("/");
                    parentContainerId = separatorIndex > 0
                        ? containerId.substring(0, separatorIndex)
                        : "root";
                }
                var record = {
                    assetId: assetId,
                    cleanSelf: fields[2] === "1",
                    depth: Number(fields[3]),
                    depthBits: Number(fields[4]),
                    parentDepthBits: fields[5] === ""
                        ? null
                        : Number(fields[5]),
                    colorMode: Number(fields[6]),
                    payloadBytes: Number(fields[7]),
                    originalName: decodePlanText(fields[8] || ""),
                    containerId: containerId,
                    parentContainerId: parentContainerId || "root"
                };
                if (plan.openIds[assetId] === undefined) {
                    plan.openIds[assetId] = [];
                }
                plan.openIds[assetId].push(record);
                plan.openRecords.push(record);
                var nameKey = normalizeFileName(record.originalName);
                if (nameKey) {
                    if (plan.openNames[nameKey] === undefined) {
                        plan.openNames[nameKey] = [];
                    }
                    plan.openNames[nameKey].push(record);
                }
                plan.recordCount++;
            }
        }

        if (
            plan.sourceBytes === null ||
            plan.sourceBytes !== sourceFile.length
        ) {
            throw new Error(
                "Cleanup plan source size mismatch: plan=" +
                plan.sourceBytes + " actual=" + sourceFile.length
            );
        }
        var actualMtimeMs = sourceFile.modified.getTime();
        if (
            plan.sourceMtimeMs === null ||
            Math.abs(plan.sourceMtimeMs - actualMtimeMs) > 2000
        ) {
            throw new Error(
                "Cleanup plan source mtime mismatch: plan=" +
                plan.sourceMtimeMs + " actual=" + actualMtimeMs
            );
        }
        if (plan.recordCount !== plan.recordsRequiredToOpen) {
            throw new Error(
                "Cleanup plan record count mismatch: rows=" +
                plan.recordCount +
                " expected=" + plan.recordsRequiredToOpen
            );
        }
        var plannedAssetId;
        for (plannedAssetId in plan.openIds) {
            if (!plan.openIds.hasOwnProperty(plannedAssetId)) {
                continue;
            }
            plan.uniqueAssetRecords++;
            if (plan.openIds[plannedAssetId].length > 1) {
                plan.duplicateAssetGroups++;
            }
        }
        var plannedSourcePath = plan.sourcePath
            .replace(/\//g, "\\")
            .toLowerCase();
        var actualSourcePath = sourceFile.fsName
            .replace(/\//g, "\\")
            .toLowerCase();
        if (
            plannedSourcePath &&
            plannedSourcePath !== actualSourcePath
        ) {
            throw new Error(
                "Cleanup plan source path mismatch: plan=" +
                plan.sourcePath + " actual=" + sourceFile.fsName
            );
        }
        return plan;
    }

    function getDocumentBitDepth(documentRef) {
        try {
            if (documentRef.bitsPerChannel === BitsPerChannelType.ONE) {
                return 1;
            }
            if (documentRef.bitsPerChannel === BitsPerChannelType.EIGHT) {
                return 8;
            }
            if (documentRef.bitsPerChannel === BitsPerChannelType.SIXTEEN) {
                return 16;
            }
            if (documentRef.bitsPerChannel === BitsPerChannelType.THIRTYTWO) {
                return 32;
            }
        } catch (ignoredBitDepth) {
        }
        return null;
    }

    function findOpenDocumentByPath(path) {
        var normalizedPath = String(path)
            .replace(/\//g, "\\")
            .toLowerCase();
        var i;
        for (i = 0; i < app.documents.length; i++) {
            try {
                var openPath = app.documents[i].fullName.fsName
                    .replace(/\//g, "\\")
                    .toLowerCase();
                if (openPath === normalizedPath) {
                    return app.documents[i];
                }
            } catch (ignoredOpenDocumentPath) {
            }
        }
        return null;
    }

    function safeGetBoolean(target, propertyName) {
        try {
            return target[propertyName] === true;
        } catch (ignoredRead) {
            return null;
        }
    }

    function safeSetBoolean(target, propertyName, value) {
        if (value === null) {
            return;
        }
        try {
            if ((target[propertyName] === true) !== value) {
                target[propertyName] = value;
            }
        } catch (ignoredWrite) {
        }
    }

    function collectLayerStates(container, depth, output) {
        var i;
        for (i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            var state = {
                id: layer.id,
                name: layer.name,
                type: layer.typename,
                depth: depth,
                visible: safeGetBoolean(layer, "visible"),
                allLocked: safeGetBoolean(layer, "allLocked"),
                pixelsLocked: null,
                positionLocked: null,
                transparentPixelsLocked: null
            };

            if (layer.typename === "ArtLayer") {
                state.pixelsLocked = safeGetBoolean(layer, "pixelsLocked");
                state.positionLocked = safeGetBoolean(layer, "positionLocked");
                state.transparentPixelsLocked = safeGetBoolean(
                    layer,
                    "transparentPixelsLocked"
                );
            }

            output.push(state);
            if (layer.typename === "LayerSet") {
                collectLayerStates(layer, depth + 1, output);
            }
        }
    }

    function findLayerById(container, layerId) {
        var i;
        for (i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            if (layer.id === layerId) {
                return layer;
            }
            if (layer.typename === "LayerSet") {
                var nested = findLayerById(layer, layerId);
                if (nested !== null) {
                    return nested;
                }
            }
        }
        return null;
    }

    function buildLayerMap(container, output) {
        var i;
        for (i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            output[String(layer.id)] = layer;
            if (layer.typename === "LayerSet") {
                buildLayerMap(layer, output);
            }
        }
    }

    function compareStateRecords(left, right) {
        return (
            left.id === right.id &&
            left.type === right.type &&
            left.visible === right.visible &&
            left.allLocked === right.allLocked &&
            left.pixelsLocked === right.pixelsLocked &&
            left.positionLocked === right.positionLocked &&
            left.transparentPixelsLocked === right.transparentPixelsLocked
        );
    }

    function sortStatesById(states) {
        var copy = states.slice(0);
        copy.sort(function (left, right) {
            return left.id - right.id;
        });
        return copy;
    }

    function snapshotDocumentState(documentRef) {
        var states = [];
        collectLayerStates(documentRef, 0, states);
        var activeLayerId = null;
        try {
            activeLayerId = documentRef.activeLayer.id;
        } catch (ignoredActiveLayer) {
        }
        return {
            layers: states,
            activeLayerId: activeLayerId
        };
    }

    function compareDocumentState(documentRef, snapshot) {
        var currentStates = [];
        collectLayerStates(documentRef, 0, currentStates);
        var expected = sortStatesById(snapshot.layers);
        var actual = sortStatesById(currentStates);
        var differences = [];
        var i;

        if (expected.length !== actual.length) {
            differences.push(
                "layerCount expected=" + expected.length +
                " actual=" + actual.length
            );
        }

        var length = Math.min(expected.length, actual.length);
        for (i = 0; i < length; i++) {
            if (!compareStateRecords(expected[i], actual[i])) {
                differences.push(
                    "layerId=" + expected[i].id +
                    " name=" + expected[i].name +
                    " expectedVisible=" + expected[i].visible +
                    " actualVisible=" + actual[i].visible +
                    " expectedAllLocked=" + expected[i].allLocked +
                    " actualAllLocked=" + actual[i].allLocked
                );
            }
        }
        return differences;
    }

    function unlockLayerForStateRestore(layer) {
        safeSetBoolean(layer, "allLocked", false);
        if (layer.typename === "ArtLayer") {
            safeSetBoolean(layer, "pixelsLocked", false);
            safeSetBoolean(layer, "positionLocked", false);
            safeSetBoolean(layer, "transparentPixelsLocked", false);
        }
    }

    function restoreDocumentState(documentRef, snapshot, label) {
        var restoreStartedMs = new Date().getTime();
        var statesAscending = snapshot.layers.slice(0);
        statesAscending.sort(function (left, right) {
            if (left.depth !== right.depth) {
                return left.depth - right.depth;
            }
            return left.id - right.id;
        });

        var statesDescending = snapshot.layers.slice(0);
        statesDescending.sort(function (left, right) {
            if (left.depth !== right.depth) {
                return right.depth - left.depth;
            }
            return left.id - right.id;
        });

        var i;
        var layer;
        var layerMap = {};
        buildLayerMap(documentRef, layerMap);

        for (i = 0; i < statesAscending.length; i++) {
            layer = layerMap[String(statesAscending[i].id)];
            if (layer !== undefined) {
                unlockLayerForStateRestore(layer);
            }
        }

        if (snapshot.activeLayerId !== null) {
            var originalActiveLayer =
                layerMap[String(snapshot.activeLayerId)];
            if (originalActiveLayer !== undefined) {
                try {
                    if (documentRef.activeLayer.id !== originalActiveLayer.id) {
                        documentRef.activeLayer = originalActiveLayer;
                    }
                } catch (ignoredRestoreActiveLayer) {
                }
            }
        }

        for (i = 0; i < statesDescending.length; i++) {
            layer = layerMap[String(statesDescending[i].id)];
            if (layer === undefined) {
                continue;
            }
            if (layer.typename === "ArtLayer") {
                safeSetBoolean(
                    layer,
                    "transparentPixelsLocked",
                    statesDescending[i].transparentPixelsLocked
                );
                safeSetBoolean(
                    layer,
                    "pixelsLocked",
                    statesDescending[i].pixelsLocked
                );
                safeSetBoolean(
                    layer,
                    "positionLocked",
                    statesDescending[i].positionLocked
                );
            }
            safeSetBoolean(
                layer,
                "allLocked",
                statesDescending[i].allLocked
            );
        }

        // Selecting or activating a hidden layer can make Photoshop reveal it.
        // Visibility must therefore be the final restored property.
        for (i = 0; i < statesAscending.length; i++) {
            layer = layerMap[String(statesAscending[i].id)];
            if (layer !== undefined) {
                safeSetBoolean(layer, "visible", statesAscending[i].visible);
            }
        }

        var differences = compareDocumentState(documentRef, snapshot);
        if (differences.length > 0) {
            logLine(
                "STATE_RESTORE\tMISMATCH\t" + label +
                "\tdifferences=" + differences.length +
                "\t" + differences.slice(0, 5).join(" || ")
            );
            throw new Error(
                "Layer state restoration failed for " + label +
                ": " + differences.slice(0, 3).join(" || ")
            );
        }
        logLine(
            "STATE_RESTORE\tOK\t" + label +
            "\tlayers=" + snapshot.layers.length +
            "\telapsedMs=" + (new Date().getTime() - restoreStartedMs)
        );
    }

    function unlockTargetAndAncestors(layer) {
        var chain = [];
        var current = layer;
        while (current && current.typename !== "Document") {
            chain.push(current);
            current = current.parent;
        }
        chain.reverse();

        var i;
        for (i = 0; i < chain.length; i++) {
            unlockLayerForStateRestore(chain[i]);
        }
    }

    function snapshotTargetAndAncestors(layer, documentRef) {
        var chain = [];
        var current = layer;
        while (current && current.typename !== "Document") {
            chain.push({
                layer: current,
                visible: safeGetBoolean(current, "visible"),
                allLocked: safeGetBoolean(current, "allLocked"),
                pixelsLocked: current.typename === "ArtLayer"
                    ? safeGetBoolean(current, "pixelsLocked")
                    : null,
                positionLocked: current.typename === "ArtLayer"
                    ? safeGetBoolean(current, "positionLocked")
                    : null,
                transparentPixelsLocked: current.typename === "ArtLayer"
                    ? safeGetBoolean(current, "transparentPixelsLocked")
                    : null
            });
            current = current.parent;
        }
        var activeLayer = null;
        try {
            activeLayer = documentRef.activeLayer;
        } catch (ignoredActiveLayerReference) {
        }
        return {
            chain: chain,
            activeLayer: activeLayer
        };
    }

    function restoreTargetAndAncestors(documentRef, snapshot, label) {
        var restoreStartedMs = new Date().getTime();
        var i;
        var state;
        for (i = snapshot.chain.length - 1; i >= 0; i--) {
            unlockLayerForStateRestore(snapshot.chain[i].layer);
        }
        if (snapshot.activeLayer !== null) {
            try {
                documentRef.activeLayer = snapshot.activeLayer;
            } catch (ignoredRestoreActiveLayerReference) {
            }
        }
        for (i = 0; i < snapshot.chain.length; i++) {
            state = snapshot.chain[i];
            if (state.layer.typename === "ArtLayer") {
                safeSetBoolean(
                    state.layer,
                    "transparentPixelsLocked",
                    state.transparentPixelsLocked
                );
                safeSetBoolean(state.layer, "pixelsLocked", state.pixelsLocked);
                safeSetBoolean(state.layer, "positionLocked", state.positionLocked);
            }
            safeSetBoolean(state.layer, "allLocked", state.allLocked);
        }
        // Activating a hidden layer may reveal it, therefore restore visibility last.
        for (i = snapshot.chain.length - 1; i >= 0; i--) {
            state = snapshot.chain[i];
            safeSetBoolean(state.layer, "visible", state.visible);
        }
        logLine(
            "STATE_RESTORE\tLOCAL_OK\t" + label +
            "\tlayers=" + snapshot.chain.length +
            "\telapsedMs=" + (new Date().getTime() - restoreStartedMs)
        );
    }

    function exportFlattenedPng(documentRef, destinationPath) {
        app.activeDocument = documentRef;
        var duplicate = documentRef.duplicate();
        duplicate.flatten();
        var options = new PNGSaveOptions();
        options.compression = 0;
        options.interlaced = false;
        duplicate.saveAs(
            new File(destinationPath),
            options,
            true,
            Extension.LOWERCASE
        );
        duplicate.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = documentRef;
    }

    function executePsbSave(documentRef, destinationFile, asCopy) {
        app.activeDocument = documentRef;
        var s2t = function (value) {
            return app.stringIDToTypeID(value);
        };
        var descriptor = new ActionDescriptor();
        var formatDescriptor = new ActionDescriptor();
        descriptor.putObject(
            s2t("as"),
            s2t("largeDocumentFormat"),
            formatDescriptor
        );
        descriptor.putPath(s2t("in"), destinationFile);
        descriptor.putBoolean(s2t("copy"), asCopy);
        descriptor.putBoolean(s2t("lowerCase"), true);
        executeAction(s2t("save"), descriptor, DialogModes.NO);
    }

    function executePsdSave(documentRef, destinationFile, asCopy) {
        app.activeDocument = documentRef;
        var options = new PhotoshopSaveOptions();
        options.alphaChannels = true;
        options.annotations = true;
        options.embedColorProfile = true;
        options.layers = true;
        options.spotColors = true;
        documentRef.saveAs(
            destinationFile,
            options,
            asCopy,
            Extension.LOWERCASE
        );
    }

    function waitForConfirmedOutput(destinationFile, timeoutMs) {
        var startedMs = new Date().getTime();
        var previousLength = -1;
        var stableObservations = 0;
        while (new Date().getTime() - startedMs <= timeoutMs) {
            var refreshed = new File(destinationFile.fsName);
            if (refreshed.exists && refreshed.length > 0) {
                if (refreshed.length === previousLength) {
                    stableObservations++;
                } else {
                    previousLength = refreshed.length;
                    stableObservations = 0;
                }
                if (stableObservations >= 2) {
                    return refreshed.length;
                }
            }
            $.sleep(250);
        }
        throw new Error(
            "Photoshop save returned but the exact output file was not confirmed: " +
            destinationFile.fsName
        );
    }

    function saveDocumentCopy(documentRef, destinationFile, asCopy) {
        app.activeDocument = documentRef;
        var lowerName = destinationFile.name.toLowerCase();
        var format = null;
        if (/\.psd$/i.test(lowerName)) {
            format = "PSD";
        } else if (/\.psb$/i.test(lowerName)) {
            format = "PSB";
        } else {
            throw new Error(
                "Unsupported Photoshop output extension: " +
                destinationFile.name
            );
        }
        logLine(
            "OUTPUT_SAVE_COMMAND_STARTED\tformat=" + format +
            "\tcopy=" + asCopy +
            "\tpath=" + destinationFile.fsName
        );
        if (format === "PSD") {
            executePsdSave(documentRef, destinationFile, asCopy);
        } else {
            try {
                executePsbSave(documentRef, destinationFile, asCopy);
            } catch (primarySaveError) {
                logLine(
                    "OUTPUT_SAVE_RETRY\tprimaryError=" +
                    primarySaveError.message +
                    "\tprimaryLine=" + primarySaveError.line +
                    "\tretryCopy=" + (!asCopy)
                );
                executePsbSave(documentRef, destinationFile, !asCopy);
            }
        }
        logLine(
            "OUTPUT_SAVE_COMMAND_RETURNED\tformat=" + format +
            "\tpath=" + destinationFile.fsName
        );
        var confirmedBytes = waitForConfirmedOutput(
            destinationFile,
            15000
        );
        logLine(
            "OUTPUT_FILE_CONFIRMED\tformat=" + format +
            "\tbytes=" + confirmedBytes +
            "\tpath=" + destinationFile.fsName
        );
    }

    function encodeLayerLogValue(value) {
        try {
            return encodeURIComponent(String(value || ""));
        } catch (ignoredEncode) {
            return String(value || "");
        }
    }

    function layerPath(layer) {
        var parts = [];
        var current = layer;
        while (current && current.typename !== "Document") {
            parts.unshift(String(current.name || "(未命名图层)"));
            current = current.parent;
        }
        return parts.join(" > ");
    }

    function layerSubtreeCount(layer) {
        var count = 1;
        if (layer.typename !== "LayerSet") {
            return count;
        }
        var i;
        for (i = 0; i < layer.layers.length; i++) {
            count += layerSubtreeCount(layer.layers[i]);
        }
        return count;
    }

    function layerActionDescriptor(layer) {
        try {
            var reference = new ActionReference();
            reference.putIdentifier(charIDToTypeID("Lyr "), layer.id);
            return executeActionGet(reference);
        } catch (ignoredDescriptor) {
            return null;
        }
    }

    function descriptorBoolean(descriptor, keyName) {
        if (descriptor === null) {
            return false;
        }
        try {
            var key = stringIDToTypeID(keyName);
            return descriptor.hasKey(key) && descriptor.getBoolean(key);
        } catch (ignoredBoolean) {
            return false;
        }
    }

    function descriptorHasKey(descriptor, keyName) {
        if (descriptor === null) {
            return false;
        }
        try {
            return descriptor.hasKey(stringIDToTypeID(keyName));
        } catch (ignoredKey) {
            return false;
        }
    }

    function layerBoundsAreEmpty(layer) {
        try {
            var bounds = layer.bounds;
            var width = bounds[2].as("px") - bounds[0].as("px");
            var height = bounds[3].as("px") - bounds[1].as("px");
            return width <= 0 || height <= 0;
        } catch (ignoredBounds) {
            return false;
        }
    }

    function emptyPixelLayerDecision(layer) {
        if (layer.typename !== "ArtLayer" || !layerBoundsAreEmpty(layer)) {
            return { empty: false, deletable: false, reason: "" };
        }
        try {
            if (layer.kind !== LayerKind.NORMAL) {
                return {
                    empty: true,
                    deletable: false,
                    reason: "not_ordinary_pixel_layer"
                };
            }
        } catch (kindError) {
            return {
                empty: true,
                deletable: false,
                reason: "layer_kind_unknown"
            };
        }
        try {
            if (layer.isBackgroundLayer) {
                return {
                    empty: true,
                    deletable: false,
                    reason: "background_layer"
                };
            }
        } catch (ignoredBackground) {
        }
        try {
            if (layer.grouped) {
                return {
                    empty: true,
                    deletable: false,
                    reason: "clipping_relationship"
                };
            }
        } catch (ignoredGrouped) {
        }
        var descriptor = layerActionDescriptor(layer);
        if (
            descriptorBoolean(descriptor, "hasUserMask") ||
            descriptorBoolean(descriptor, "hasVectorMask") ||
            descriptorHasKey(descriptor, "layerEffects")
        ) {
            return {
                empty: true,
                deletable: false,
                reason: "mask_or_layer_effect"
            };
        }
        return { empty: true, deletable: true, reason: "bounds_empty" };
    }

    function collectDirectlyHiddenLayers(container, output) {
        var i;
        for (i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            var visible = true;
            try {
                visible = layer.visible;
            } catch (ignoredVisible) {
            }
            if (!visible) {
                output.push(layer);
            } else if (layer.typename === "LayerSet") {
                collectDirectlyHiddenLayers(layer, output);
            }
        }
    }

    function collectEmptyPixelLayers(container, output) {
        var i;
        for (i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            if (layer.typename === "LayerSet") {
                collectEmptyPixelLayers(layer, output);
            } else if (layer.typename === "ArtLayer") {
                var decision = emptyPixelLayerDecision(layer);
                if (decision.empty) {
                    output.push({ layer: layer, decision: decision });
                }
            }
        }
    }

    function deleteLayerWithAudit(layer, kind, reason) {
        var pathBefore = layerPath(layer);
        var nameBefore = String(layer.name || "(未命名图层)");
        var typeBefore = layer.typename;
        var idBefore = null;
        try {
            idBefore = layer.id;
        } catch (ignoredId) {
        }
        var subtreeCount = layerSubtreeCount(layer);
        unlockTargetAndAncestors(layer);
        layer.remove();
        logLine(
            "LAYER_CLEANUP\tDELETED\tkind=" + kind +
            "\tid=" + idBefore +
            "\ttype=" + encodeLayerLogValue(typeBefore) +
            "\tname=" + encodeLayerLogValue(nameBefore) +
            "\tpath=" + encodeLayerLogValue(pathBefore) +
            "\treason=" + encodeLayerLogValue(reason) +
            "\tsubtreeLayers=" + subtreeCount
        );
    }

    function cleanupRootDocumentLayers(documentRef) {
        var hiddenDeleted = 0;
        var hiddenSkipped = 0;
        var emptyDeleted = 0;
        var emptySkipped = 0;
        logLine(
            "LAYER_CLEANUP\tSTART\thidden=" + deleteHiddenLayers +
            "\tempty=" + deleteEmptyLayers +
            "\tscope=root_document_only"
        );
        if (deleteHiddenLayers) {
            var hiddenCandidates = [];
            collectDirectlyHiddenLayers(documentRef, hiddenCandidates);
            var hiddenIndex;
            for (hiddenIndex = hiddenCandidates.length - 1; hiddenIndex >= 0; hiddenIndex--) {
                try {
                    deleteLayerWithAudit(
                        hiddenCandidates[hiddenIndex],
                        "hidden",
                        "direct_visibility_off"
                    );
                    hiddenDeleted++;
                } catch (hiddenDeleteError) {
                    logLine(
                        "LAYER_CLEANUP\tSKIPPED\tkind=hidden" +
                        "\tpath=" + encodeLayerLogValue(layerPath(hiddenCandidates[hiddenIndex])) +
                        "\treason=" + encodeLayerLogValue(
                            "delete_error: " + hiddenDeleteError.message
                        )
                    );
                    hiddenSkipped++;
                }
            }
        }
        if (deleteEmptyLayers) {
            var emptyCandidates = [];
            collectEmptyPixelLayers(documentRef, emptyCandidates);
            var emptyIndex;
            for (emptyIndex = emptyCandidates.length - 1; emptyIndex >= 0; emptyIndex--) {
                var candidate = emptyCandidates[emptyIndex];
                if (!candidate.decision.deletable) {
                    logLine(
                        "LAYER_CLEANUP\tSKIPPED\tkind=empty" +
                        "\tid=" + candidate.layer.id +
                        "\ttype=" + encodeLayerLogValue(candidate.layer.typename) +
                        "\tname=" + encodeLayerLogValue(candidate.layer.name) +
                        "\tpath=" + encodeLayerLogValue(layerPath(candidate.layer)) +
                        "\treason=" + encodeLayerLogValue(candidate.decision.reason)
                    );
                    emptySkipped++;
                    continue;
                }
                try {
                    deleteLayerWithAudit(
                        candidate.layer,
                        "empty",
                        candidate.decision.reason
                    );
                    emptyDeleted++;
                } catch (emptyDeleteError) {
                    logLine(
                        "LAYER_CLEANUP\tSKIPPED\tkind=empty" +
                        "\tpath=" + encodeLayerLogValue(layerPath(candidate.layer)) +
                        "\treason=" + encodeLayerLogValue(
                            "delete_error: " + emptyDeleteError.message
                        )
                    );
                    emptySkipped++;
                }
            }
        }
        logLine(
            "LAYER_CLEANUP\tSUMMARY\tdeletedHidden=" + hiddenDeleted +
            "\tdeletedEmpty=" + emptyDeleted +
            "\tskippedHidden=" + hiddenSkipped +
            "\tskippedEmpty=" + emptySkipped
        );
        return hiddenDeleted + emptyDeleted > 0;
    }

    function clearDocumentAncestors(documentRef, label) {
        checkCancellation("XMP_START " + label);
        app.activeDocument = documentRef;
        var originalRaw = documentRef.xmpMetadata.rawData;
        checkCancellation("XMP_AFTER_READ " + label);
        var xmp = new XMPMeta(originalRaw);
        var propertyExists = false;
        var itemCount = 0;

        try {
            propertyExists = xmp.doesPropertyExist(
                XMPConst.NS_PHOTOSHOP,
                "DocumentAncestors"
            );
        } catch (ignoredDoesPropertyExist) {
            propertyExists = originalRaw.indexOf("DocumentAncestors") >= 0;
        }

        if (!propertyExists) {
            logLine("XMP_CLEAN\tSKIP\t" + label);
            return false;
        }

        try {
            itemCount = xmp.countArrayItems(
                XMPConst.NS_PHOTOSHOP,
                "DocumentAncestors"
            );
        } catch (ignoredCountArrayItems) {
            itemCount = -1;
        }

        xmp.deleteProperty(XMPConst.NS_PHOTOSHOP, "DocumentAncestors");
        var cleanedRaw = xmp.serialize(XMPConst.SERIALIZE_USE_COMPACT_FORMAT);
        checkCancellation("XMP_BEFORE_WRITE " + label);
        documentRef.xmpMetadata.rawData = cleanedRaw;
        logLine(
            "XMP_CLEAN\tDONE\t" + label +
            "\titems=" + itemCount +
            "\trawCharsBefore=" + originalRaw.length +
            "\trawCharsAfter=" + cleanedRaw.length
        );
        return true;
    }

    function getStringValue(descriptor, keyName) {
        var key = stringIDToTypeID(keyName);
        if (!descriptor.hasKey(key)) {
            return "";
        }
        try {
            if (descriptor.getType(key) === DescValueType.STRINGTYPE) {
                return descriptor.getString(key);
            }
            if (descriptor.getType(key) === DescValueType.ALIASTYPE) {
                return descriptor.getPath(key).fsName;
            }
        } catch (ignoredGetString) {
        }
        return "";
    }

    function pushUniqueValue(output, value) {
        var normalized = trimText(value);
        if (!normalized) {
            return;
        }
        var i;
        for (i = 0; i < output.length; i++) {
            if (output[i] === normalized) {
                return;
            }
        }
        output.push(normalized);
    }

    function collectAssetIdCandidates(descriptor, output) {
        var idKeys = [
            "ID",
            "placed",
            "uniqueID",
            "uuid",
            "smartObjectID"
        ];
        var i;
        for (i = 0; i < idKeys.length; i++) {
            var rawValue = getStringValue(descriptor, idKeys[i]);
            var assetId = normalizeAssetId(rawValue);
            if (assetId) {
                pushUniqueValue(output, assetId);
            }
        }
    }

    function getSmartObjectInfo(layer) {
        var reference = new ActionReference();
        reference.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        var layerDescriptor = executeActionGet(reference);
        var candidates = [];
        var assetIds = [];
        var linkedState = null;
        var containerKeys = ["smartObject", "smartObjectMore"];
        var valueKeys = [
            "fileReference",
            "originalFileName",
            "linkedFile",
            "link"
        ];
        var i;
        var j;

        for (i = 0; i < containerKeys.length; i++) {
            var containerKey = stringIDToTypeID(containerKeys[i]);
            if (!layerDescriptor.hasKey(containerKey)) {
                continue;
            }
            try {
                var objectDescriptor = layerDescriptor.getObjectValue(containerKey);
                collectAssetIdCandidates(objectDescriptor, assetIds);
                var linkedKey = stringIDToTypeID("linked");
                if (
                    linkedState === null &&
                    objectDescriptor.hasKey(linkedKey) &&
                    objectDescriptor.getType(linkedKey) === DescValueType.BOOLEANTYPE
                ) {
                    linkedState = objectDescriptor.getBoolean(linkedKey);
                }
                for (j = 0; j < valueKeys.length; j++) {
                    var value = getStringValue(
                        objectDescriptor,
                        valueKeys[j]
                    );
                    if (value) {
                        pushUniqueValue(candidates, value);
                    }
                }
            } catch (ignoredContainer) {
            }
        }
        collectAssetIdCandidates(layerDescriptor, assetIds);

        var directLinkedKey = stringIDToTypeID("linked");
        if (
            linkedState === null &&
            layerDescriptor.hasKey(directLinkedKey) &&
            layerDescriptor.getType(directLinkedKey) === DescValueType.BOOLEANTYPE
        ) {
            linkedState = layerDescriptor.getBoolean(directLinkedKey);
        }

        return {
            fileReference: candidates.length > 0
                ? candidates[0]
                : (layer.name || ""),
            linked: linkedState,
            assetIds: assetIds
        };
    }

    function recordCoverageKey(record) {
        return record && record.containerId
            ? record.containerId
            : (record ? record.assetId : "");
    }

    function choosePlanRecord(records, parentContainerId) {
        if (!records || records.length === 0) {
            return null;
        }
        var i;
        for (i = 0; i < records.length; i++) {
            if (
                records[i].parentContainerId === parentContainerId &&
                planCoverage[recordCoverageKey(records[i])] !== true
            ) {
                return records[i];
            }
        }
        for (i = 0; i < records.length; i++) {
            if (records[i].parentContainerId === parentContainerId) {
                return records[i];
            }
        }
        return records.length === 1 ? records[0] : null;
    }

    function findPlanDecision(
        smartObjectInfo,
        layerName,
        parentContainerId
    ) {
        var i;
        for (i = 0; i < smartObjectInfo.assetIds.length; i++) {
            var assetId = smartObjectInfo.assetIds[i];
            if (cleanupPlan.openIds[assetId] !== undefined) {
                var idRecord = choosePlanRecord(
                    cleanupPlan.openIds[assetId],
                    parentContainerId
                );
                if (idRecord === null) {
                    continue;
                }
                return {
                    shouldOpen: true,
                    matchMode: "ID",
                    assetId: assetId,
                    record: idRecord
                };
            }
        }
        if (smartObjectInfo.assetIds.length > 0) {
            return {
                shouldOpen: false,
                matchMode: "ID_NOT_TARGETED",
                assetId: "",
                record: null
            };
        }

        var nameCandidates = [
            normalizeFileName(smartObjectInfo.fileReference),
            normalizeFileName(layerName)
        ];
        for (i = 0; i < nameCandidates.length; i++) {
            var nameKey = nameCandidates[i];
            if (
                nameKey &&
                cleanupPlan.openNames[nameKey] !== undefined
            ) {
                var matches = cleanupPlan.openNames[nameKey];
                var fallbackRecord = choosePlanRecord(
                    matches,
                    parentContainerId
                );
                if (fallbackRecord === null) {
                    continue;
                }
                return {
                    shouldOpen: true,
                    matchMode: matches.length === 1
                        ? "NAME_FALLBACK"
                        : "NAME_FALLBACK_AMBIGUOUS",
                    assetId: "",
                    record: fallbackRecord
                };
            }
        }

        return {
            shouldOpen: false,
            matchMode: "NO_ID_OR_TARGET_NAME",
            assetId: "",
            record: null
        };
    }

    function markPlanRecordCovered(record) {
        var key = recordCoverageKey(record);
        if (key) {
            planCoverage[key] = true;
        }
    }

    function getUncoveredPlanIds() {
        var uncovered = [];
        var i;
        for (i = 0; i < cleanupPlan.openRecords.length; i++) {
            var record = cleanupPlan.openRecords[i];
            var key = recordCoverageKey(record);
            if (
                key &&
                planCoverage[key] !== true
            ) {
                uncovered.push(key + "=" + record.assetId);
            }
        }
        uncovered.sort();
        return uncovered;
    }

    function findProcessedSharedId(assetIds, parentContainerId) {
        var scope = processedSharedIdsByScope[parentContainerId];
        if (scope === undefined) {
            return "";
        }
        var i;
        for (i = 0; i < assetIds.length; i++) {
            if (scope[assetIds[i]] !== undefined) {
                return assetIds[i];
            }
        }
        return "";
    }

    function getProcessedSharedRecord(parentContainerId, assetId) {
        var scope = processedSharedIdsByScope[parentContainerId];
        return scope === undefined ? null : scope[assetId];
    }

    function markSharedIdsProcessed(assetIds, record, parentContainerId) {
        if (processedSharedIdsByScope[parentContainerId] === undefined) {
            processedSharedIdsByScope[parentContainerId] = {};
        }
        var scope = processedSharedIdsByScope[parentContainerId];
        var i;
        for (i = 0; i < assetIds.length; i++) {
            scope[assetIds[i]] = record;
        }
    }

    function collectSmartLayerRecords(container, output) {
        var i;
        for (i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i];
            if (layer.typename === "LayerSet") {
                collectSmartLayerRecords(layer, output);
            } else if (
                layer.typename === "ArtLayer" &&
                layer.kind === LayerKind.SMARTOBJECT
            ) {
                output.push({
                    id: layer.id,
                    name: layer.name
                });
            }
        }
    }

    function auditRootPlanIds(documentRef, label) {
        app.activeDocument = documentRef;
        var smartLayers = [];
        collectSmartLayerRecords(documentRef, smartLayers);
        var matchedDirectPlanIds = {};
        var candidateIdOccurrences = {};
        var idMatchedLayers = 0;
        var nameFallbackLayers = 0;
        var nonTargetLayers = 0;
        var layersWithoutAssetId = 0;
        var i;
        var j;

        for (i = 0; i < smartLayers.length; i++) {
            var layer = findLayerById(documentRef, smartLayers[i].id);
            if (layer === null) {
                continue;
            }
            var info = getSmartObjectInfo(layer);
            if (info.assetIds.length === 0) {
                layersWithoutAssetId++;
            }
            for (j = 0; j < info.assetIds.length; j++) {
                var candidateId = info.assetIds[j];
                if (candidateIdOccurrences[candidateId] === undefined) {
                    candidateIdOccurrences[candidateId] = 0;
                }
                candidateIdOccurrences[candidateId]++;
            }

            var decision = findPlanDecision(info, layer.name, "root");
            if (decision.matchMode === "ID") {
                idMatchedLayers++;
                matchedDirectPlanIds[decision.record.assetId] = true;
            } else if (decision.shouldOpen) {
                nameFallbackLayers++;
            } else {
                nonTargetLayers++;
            }
            logLine(
                "ID_AUDIT\tLAYER\t" + label + " > " + layer.name +
                "\tfileReference=" + info.fileReference +
                "\tassetIds=" +
                (info.assetIds.length > 0
                    ? info.assetIds.join(",")
                    : "NONE") +
                "\tmatchMode=" + decision.matchMode +
                "\tplanAssetId=" +
                (decision.record === null
                    ? ""
                    : decision.record.assetId)
            );
        }

        var directPlanIds = [];
        var missingDirectPlanIds = [];
        var directRecordIndex;
        for (
            directRecordIndex = 0;
            directRecordIndex < cleanupPlan.openRecords.length;
            directRecordIndex++
        ) {
            var directRecord = cleanupPlan.openRecords[directRecordIndex];
            if (directRecord.depth !== 1) {
                continue;
            }
            directPlanIds.push(
                directRecord.containerId + "=" + directRecord.assetId
            );
            if (matchedDirectPlanIds[directRecord.assetId] !== true) {
                missingDirectPlanIds.push(
                    directRecord.containerId + "=" + directRecord.assetId
                );
            }
        }

        var repeatedCandidateIds = 0;
        var repeatedTargetInstances = 0;
        var observedId;
        for (observedId in candidateIdOccurrences) {
            if (!candidateIdOccurrences.hasOwnProperty(observedId)) {
                continue;
            }
            if (candidateIdOccurrences[observedId] > 1) {
                repeatedCandidateIds++;
                if (cleanupPlan.openIds[observedId] !== undefined) {
                    repeatedTargetInstances +=
                        candidateIdOccurrences[observedId] - 1;
                }
            }
        }

        logLine(
            "ID_AUDIT\tSUMMARY\trootSmartLayers=" +
            smartLayers.length +
            "\tdirectPlanIds=" + directPlanIds.length +
            "\tmatchedDirectPlanIds=" +
            (directPlanIds.length - missingDirectPlanIds.length) +
            "\tmissingDirectPlanIds=" +
            missingDirectPlanIds.length +
            "\tidMatchedLayers=" + idMatchedLayers +
            "\tnameFallbackLayers=" + nameFallbackLayers +
            "\tnonTargetLayers=" + nonTargetLayers +
            "\tlayersWithoutAssetId=" + layersWithoutAssetId +
            "\trepeatedCandidateIds=" + repeatedCandidateIds +
            "\trepeatedTargetInstances=" +
            repeatedTargetInstances
        );
        if (missingDirectPlanIds.length > 0) {
            logLine(
                "ID_AUDIT\tMISSING_DIRECT_IDS\t" +
                missingDirectPlanIds.join(",")
            );
        }
    }

    var cleanupPlan = null;
    var processedSharedIdsByScope = {};
    var planCoverage = {};
    var planTerminal = {};
    var plannedObjectsCompleted = 0;
    var plannedObjectsFailed = 0;
    var visitedDocuments = 0;
    var scannedSmartObjects = 0;
    var openedSmartObjects = 0;
    var skippedSmartObjects = 0;
    var preflightSkippedSmartObjects = 0;
    var sharedSkippedSmartObjects = 0;
    var planIdMatches = 0;
    var planNameFallbackMatches = 0;
    var smartObjectsWithoutAssetId = 0;
    var crossBitDepthSmartObjectsOpened = 0;
    var xmpChecksSkippedByPlan = 0;
    var cleanedDocuments = 0;
    var failedSmartObjects = 0;
    var initiallyHiddenSmartObjects = 0;
    var initiallyLockedSmartObjects = 0;

    function markPlanRecordTerminal(record, outcome) {
        var key = recordCoverageKey(record);
        if (!key || planTerminal[key] === true) {
            return;
        }
        planTerminal[key] = true;
        plannedObjectsCompleted++;
        if (outcome === "ERROR") {
            plannedObjectsFailed++;
        }
        logLine(
            "PLAN_PROGRESS\tcompleted=" + plannedObjectsCompleted +
            "\ttotal=" + cleanupPlan.recordsRequiredToOpen +
            "\tfailed=" + plannedObjectsFailed +
            "\tscanned=" + scannedSmartObjects +
            "\tskipped=" + skippedSmartObjects +
            "\tcurrentId=" + key +
            "\tassetId=" + record.assetId +
            "\toutcome=" + outcome
        );
    }

    function snapshotOpenDocumentIds() {
        var ids = {};
        var index;
        for (index = 0; index < app.documents.length; index++) {
            try {
                ids[String(app.documents[index].id)] = true;
            } catch (ignoredDocumentId) {
            }
        }
        return ids;
    }

    function openDocumentIdList() {
        var ids = [];
        var index;
        for (index = 0; index < app.documents.length; index++) {
            try {
                ids.push(String(app.documents[index].id));
            } catch (ignoredDocumentId) {
            }
        }
        return ids.join(",");
    }

    function waitForNewChildDocument(parentDocument, beforeIds, timeoutMs) {
        var startedMs = new Date().getTime();
        while (new Date().getTime() - startedMs <= timeoutMs) {
            var active = null;
            try {
                active = app.activeDocument;
            } catch (ignoredActiveDocument) {
            }
            if (
                active !== null &&
                active.id !== parentDocument.id &&
                beforeIds[String(active.id)] !== true
            ) {
                return active;
            }
            var index;
            for (index = 0; index < app.documents.length; index++) {
                var candidate = app.documents[index];
                try {
                    if (
                        candidate.id !== parentDocument.id &&
                        beforeIds[String(candidate.id)] !== true
                    ) {
                        app.activeDocument = candidate;
                        return candidate;
                    }
                } catch (ignoredCandidateDocument) {
                }
            }
            $.sleep(200);
        }
        return null;
    }

    function openSmartObjectWithHandshake(
        parentDocument,
        layerId,
        childLabel
    ) {
        var beforeIds = snapshotOpenDocumentIds();
        var attempt;
        var timeouts = [15000, 30000];
        for (attempt = 0; attempt < timeouts.length; attempt++) {
            if (attempt > 0) {
                var delayedOpen = waitForNewChildDocument(
                    parentDocument,
                    beforeIds,
                    1200
                );
                if (delayedOpen !== null) {
                    logLine(
                        "SMART_OBJECT_OPEN_LATE_SUCCESS\t" + childLabel +
                        "\tattempt=" + attempt +
                        "\tafterDocumentIds=" + openDocumentIdList()
                    );
                    return delayedOpen;
                }
            }
            app.activeDocument = parentDocument;
            var currentLayer = findLayerById(parentDocument, layerId);
            if (currentLayer === null) {
                throw new Error(
                    "Smart-object layer disappeared before opening: " +
                    layerId
                );
            }
            unlockTargetAndAncestors(currentLayer);
            parentDocument.activeLayer = currentLayer;
            var attemptStartedMs = new Date().getTime();
            logLine(
                "SMART_OBJECT_OPEN_ATTEMPT\t" + childLabel +
                "\tattempt=" + (attempt + 1) +
                "\tparentDocumentId=" + parentDocument.id +
                "\tlayerId=" + layerId +
                "\tbeforeDocumentIds=" + openDocumentIdList()
            );
            executeAction(
                stringIDToTypeID("placedLayerEditContents"),
                undefined,
                DialogModes.NO
            );
            var opened = waitForNewChildDocument(
                parentDocument,
                beforeIds,
                timeouts[attempt]
            );
            logLine(
                "SMART_OBJECT_OPEN_RESULT\t" + childLabel +
                "\tattempt=" + (attempt + 1) +
                "\telapsedMs=" +
                (new Date().getTime() - attemptStartedMs) +
                "\topened=" + (opened !== null) +
                "\tafterDocumentIds=" + openDocumentIdList()
            );
            if (opened !== null) {
                return opened;
            }
            checkCancellation(
                "SMART_OBJECT_OPEN_RETRY " + childLabel +
                " attempt=" + (attempt + 1)
            );
        }
        throw new Error(
            "Smart object did not open after bounded wait and one safe retry"
        );
    }

    function processDocument(documentRef, label, depth, planRecord) {
        checkCancellation("ENTER_DOCUMENT " + label);
        if (depth > 8) {
            throw new Error("Unexpected smart-object nesting depth at " + label);
        }

        var shouldCleanSelf = depth === 0
            ? cleanupPlan.rootCleanSelf
            : (planRecord !== null && planRecord.cleanSelf === true);
        var expectedDepthBits = depth === 0
            ? cleanupPlan.rootDepthBits
            : planRecord.depthBits;
        var actualDepthBits = getDocumentBitDepth(documentRef);
        visitedDocuments++;
        app.activeDocument = documentRef;
        var entrySnapshot = snapshotDocumentState(documentRef);
        var changed = false;
        var smartLayers = [];
        collectSmartLayerRecords(documentRef, smartLayers);

        logLine(
            "DOCUMENT\t" + label +
            "\tdepth=" + depth +
            "\tsmartLayers=" + smartLayers.length +
            "\ttotalLayers=" + entrySnapshot.layers.length +
            "\twidth=" + documentRef.width.as("px") +
            "\theight=" + documentRef.height.as("px") +
            "\tplanCleanSelf=" + shouldCleanSelf +
            "\tactualDepthBits=" + actualDepthBits +
            "\texpectedDepthBits=" + expectedDepthBits +
            "\tplanAssetId=" +
            (planRecord === null ? "root" : planRecord.assetId)
        );
        if (
            actualDepthBits !== null &&
            expectedDepthBits !== null &&
            actualDepthBits !== expectedDepthBits
        ) {
            logLine(
                "DOCUMENT\tBIT_DEPTH_MISMATCH\t" + label +
                "\tactual=" + actualDepthBits +
                "\texpected=" + expectedDepthBits
            );
        }

        var i;
        for (i = 0; i < smartLayers.length; i++) {
            checkCancellation(
                "BEFORE_SMART_OBJECT " + label +
                " index=" + i
            );
            app.activeDocument = documentRef;

            var layer = findLayerById(documentRef, smartLayers[i].id);
            if (layer === null) {
                failedSmartObjects++;
                logLine(
                    "SMART_OBJECT\tERROR_LAYER_NOT_FOUND\t" + label +
                    "\tlayerId=" + smartLayers[i].id
                );
                continue;
            }

            var wasVisible = safeGetBoolean(layer, "visible");
            var wasAllLocked = safeGetBoolean(layer, "allLocked");
            var wasPixelsLocked = safeGetBoolean(layer, "pixelsLocked");
            var wasPositionLocked = safeGetBoolean(layer, "positionLocked");
            var wasTransparentPixelsLocked = safeGetBoolean(
                layer,
                "transparentPixelsLocked"
            );

            if (wasVisible === false) {
                initiallyHiddenSmartObjects++;
            }
            if (
                wasAllLocked === true ||
                wasPixelsLocked === true ||
                wasPositionLocked === true ||
                wasTransparentPixelsLocked === true
            ) {
                initiallyLockedSmartObjects++;
            }

            scannedSmartObjects++;
            var smartObjectInfo = getSmartObjectInfo(layer);
            var fileReference = smartObjectInfo.fileReference;
            if (smartObjectInfo.assetIds.length === 0) {
                smartObjectsWithoutAssetId++;
            }
            var childLabel =
                label + " > " + layer.name + " [" + fileReference + "]";

            logLine(
                "SMART_OBJECT\tSTATE\t" + childLabel +
                "\tvisible=" + wasVisible +
                "\tallLocked=" + wasAllLocked +
                "\tpixelsLocked=" + wasPixelsLocked +
                "\tpositionLocked=" + wasPositionLocked +
                "\ttransparentPixelsLocked=" + wasTransparentPixelsLocked +
                "\tassetIds=" +
                (smartObjectInfo.assetIds.length > 0
                    ? smartObjectInfo.assetIds.join(",")
                    : "NONE")
            );

            if (!/\.(psb|psd)$/i.test(fileReference)) {
                skippedSmartObjects++;
                logLine("SMART_OBJECT\tSKIP_NON_PSD\t" + childLabel);
                continue;
            }

            if (smartObjectInfo.linked !== false) {
                skippedSmartObjects++;
                logLine(
                    "SMART_OBJECT\tSKIP_NOT_CONFIRMED_EMBEDDED\t" +
                    childLabel +
                    "\tlinked=" + smartObjectInfo.linked
                );
                continue;
            }

            var planDecision = findPlanDecision(
                smartObjectInfo,
                layer.name,
                depth === 0 ? "root" : planRecord.containerId
            );
            if (!planDecision.shouldOpen) {
                skippedSmartObjects++;
                preflightSkippedSmartObjects++;
                logLine(
                    "SMART_OBJECT\tSKIP_PREFLIGHT_CLEAN\t" +
                    childLabel +
                    "\tmatchMode=" + planDecision.matchMode
                );
                continue;
            }

            if (planDecision.matchMode === "ID") {
                planIdMatches++;
            } else {
                planNameFallbackMatches++;
            }

            if (
                planDecision.record.parentDepthBits !== null &&
                planDecision.record.parentDepthBits !==
                    planDecision.record.depthBits
            ) {
                crossBitDepthSmartObjectsOpened++;
                logLine(
                    "SMART_OBJECT\tBIT_DEPTH_RISK\t" + childLabel +
                    "\tparentBits=" +
                    planDecision.record.parentDepthBits +
                    "\tchildBits=" +
                    planDecision.record.depthBits +
                    "\tassetId=" +
                    planDecision.record.assetId
                );
            }

            var processedSharedId = findProcessedSharedId(
                smartObjectInfo.assetIds,
                depth === 0 ? "root" : planRecord.containerId
            );
            if (processedSharedId) {
                skippedSmartObjects++;
                sharedSkippedSmartObjects++;
                if (planDecision.matchMode === "ID") {
                    markPlanRecordCovered(planDecision.record);
                }
                markPlanRecordTerminal(planDecision.record, "SHARED");
                logLine(
                    "SMART_OBJECT\tSKIP_SHARED_ALREADY_PROCESSED\t" +
                    childLabel +
                    "\tsharedId=" + processedSharedId +
                    "\tfirstPath=" +
                    getProcessedSharedRecord(
                        depth === 0 ? "root" : planRecord.containerId,
                        processedSharedId
                    ).path
                );
                continue;
            }

            var childDocument = null;
            var localStateSnapshot = snapshotTargetAndAncestors(
                layer,
                documentRef
            );
            try {
                unlockTargetAndAncestors(layer);
                documentRef.activeLayer = layer;
                var childOpenStartedMs = new Date().getTime();
                var openedDocument = openSmartObjectWithHandshake(
                    documentRef,
                    smartLayers[i].id,
                    childLabel
                );
                childDocument = openedDocument;
                logLine(
                    "PERF\tSMART_OBJECT_OPEN\t" + childLabel +
                    "\telapsedMs=" +
                    (new Date().getTime() - childOpenStartedMs)
                );
                checkCancellation("AFTER_SMART_OBJECT_OPEN " + childLabel);

                openedSmartObjects++;
                var childChanged = processDocument(
                    childDocument,
                    childLabel,
                    depth + 1,
                    planDecision.record
                );
                checkCancellation("BEFORE_SMART_OBJECT_SAVE " + childLabel);

                if (childChanged) {
                    var childSaveStartedMs = new Date().getTime();
                    childDocument.save();
                    logLine(
                        "PERF\tSMART_OBJECT_SAVE\t" + childLabel +
                        "\telapsedMs=" +
                        (new Date().getTime() - childSaveStartedMs)
                    );
                    checkCancellation("AFTER_SMART_OBJECT_SAVE " + childLabel);
                    childDocument.close(SaveOptions.DONOTSAVECHANGES);
                    changed = true;
                    logLine("SMART_OBJECT\tSAVED\t" + childLabel);
                } else {
                    childDocument.close(SaveOptions.DONOTSAVECHANGES);
                    logLine("SMART_OBJECT\tUNCHANGED\t" + childLabel);
                }
                childDocument = null;
                markPlanRecordCovered(planDecision.record);
                markPlanRecordTerminal(
                    planDecision.record,
                    childChanged ? "SAVED" : "UNCHANGED"
                );
                markSharedIdsProcessed(
                    smartObjectInfo.assetIds,
                    {
                        path: childLabel,
                        changed: childChanged,
                        planAssetId: planDecision.record.assetId
                    },
                    depth === 0 ? "root" : planRecord.containerId
                );
                app.activeDocument = documentRef;
                restoreTargetAndAncestors(
                    documentRef,
                    localStateSnapshot,
                    childLabel
                );
            } catch (smartObjectError) {
                if (isCancellationError(smartObjectError)) {
                    logLine(
                        "SMART_OBJECT\tCANCEL_PROPAGATE\t" + childLabel +
                        "\t" + smartObjectError.message +
                        "\tline=" + smartObjectError.line
                    );
                    try {
                        if (childDocument !== null) {
                            app.activeDocument = childDocument;
                            childDocument.close(SaveOptions.DONOTSAVECHANGES);
                        }
                    } catch (ignoredCloseOnCancel) {
                    }
                    throw smartObjectError;
                }
                failedSmartObjects++;
                markPlanRecordTerminal(planDecision.record, "ERROR");
                logLine(
                    "SMART_OBJECT\tERROR\t" + childLabel +
                    "\t" + smartObjectError.message +
                    "\tline=" + smartObjectError.line
                );
                try {
                    if (childDocument !== null) {
                        app.activeDocument = childDocument;
                        childDocument.close(SaveOptions.DONOTSAVECHANGES);
                    }
                } catch (ignoredCloseAfterError) {
                }
                app.activeDocument = documentRef;
                restoreDocumentState(documentRef, entrySnapshot, label);
            }
            checkCancellation(
                "AFTER_SMART_OBJECT " + label +
                " index=" + i
            );
        }

        if (shouldCleanSelf) {
            if (depth === 0) {
                logLine("ROOT_XMP\tSTART");
            }
            checkCancellation("BEFORE_XMP " + label);
            if (clearDocumentAncestors(documentRef, label)) {
                cleanedDocuments++;
                changed = true;
            }
            if (depth === 0) {
                logLine("ROOT_XMP\tDONE");
            }
        } else {
            xmpChecksSkippedByPlan++;
            logLine("XMP_CLEAN\tSKIP_PREFLIGHT_CLEAN\t" + label);
        }

        restoreDocumentState(documentRef, entrySnapshot, label);
        return changed;
    }

    var previousDialogs = app.displayDialogs;
    var previousDocument = app.documents.length > 0
        ? app.activeDocument
        : null;
    var sourceDocument = null;
    var sourceDocumentBorrowed = false;
    var reopenedOutput = null;
    var rootSnapshot = null;
    var saveSnapshot = null;
    var coverageMismatchCount = 0;
    var coverageMismatchPercent = 0;
    var coverageAcceptedByPolicy = true;

    try {
        app.displayDialogs = DialogModes.NO;
        ExternalObject.AdobeXMPScript = new ExternalObject(
            "lib:AdobeXMPScript"
        );

        var sourceFile = new File(sourcePath);
        var outputFile = inPlace ? null : new File(outputPath);
        var auditOnly = new File(auditOnlyFlagPath).exists;
        if (!sourceFile.exists) {
            throw new Error("Source does not exist: " + sourcePath);
        }
        if (!auditOnly && !inPlace && outputFile.exists) {
            throw new Error("Output already exists; refusing overwrite: " + outputPath);
        }
        var photoshopRuntimePath = "";
        try {
            photoshopRuntimePath = app.path.fsName;
        } catch (ignoredPhotoshopPath) {
        }
        logLine(
            "PHOTOSHOP_ENV\tversion=" + app.version +
            "\tpath=" + encodeURIComponent(photoshopRuntimePath)
        );
        cleanupPlan = loadCleanupPlan(cleanupPlanPath, sourceFile);

        logLine("STATUS=START\telapsedMs=" + elapsedMs());
        logLine(
            "TIMER\tRUN_START\tepochMs=" + runStartMs +
            "\tlocal=" + new Date(runStartMs).toString()
        );
        logLine(
            "SOURCE\t" + sourcePath +
            "\tbytes=" + sourceFile.length +
            "\tmodified=" + sourceFile.modified
        );
        logLine(
            inPlace
                ? "OUTPUT\tIN_PLACE_SOURCE"
                : "OUTPUT\t" + outputPath
        );
        logLine(
            "RUN_MODE\t" +
            (
                auditOnly
                    ? "ID_AUDIT_ONLY"
                    : inPlace
                        ? "IN_PLACE_UNVALIDATED"
                        : "FULL_OPTIMIZED_CLEANUP"
            )
        );
        logLine(
            "PREFLIGHT_PLAN\t" + cleanupPlanPath +
            "\tversion=" + cleanupPlan.version +
            "\trecordsRequiredToOpen=" +
            cleanupPlan.recordsRequiredToOpen +
            "\tuniqueAssetRecords=" +
            cleanupPlan.uniqueAssetRecords +
            "\tduplicateAssetGroups=" +
            cleanupPlan.duplicateAssetGroups +
            "\ttargetRecords=" + cleanupPlan.targetRecords +
            "\tancestorOnlyRecords=" +
            cleanupPlan.ancestorOnlyRecords +
            "\trootCleanSelf=" + cleanupPlan.rootCleanSelf +
            "\trootDepthBits=" + cleanupPlan.rootDepthBits +
            "\tcrossBitDepthRecords=" +
            cleanupPlan.crossBitDepthRecords
        );

        var alreadyOpenSource = findOpenDocumentByPath(sourcePath);
        if (alreadyOpenSource !== null) {
            if (!auditOnly) {
                throw new Error(
                    "Source is already open in Photoshop; close it before full cleanup"
                );
            }
            sourceDocument = alreadyOpenSource;
            sourceDocumentBorrowed = true;
            app.activeDocument = sourceDocument;
            logLine("SOURCE_OPEN\tREUSED_FOR_READ_ONLY_AUDIT");
        } else {
            sourceDocument = app.open(sourceFile);
            logLine("SOURCE_OPEN\tOPENED_BY_SCRIPT");
        }
        checkCancellation("AFTER_ROOT_OPEN");
        rootSnapshot = snapshotDocumentState(sourceDocument);
        saveSnapshot = rootSnapshot;
        logLine(
            "ROOT_OPENED\tname=" + sourceDocument.name +
            "\ttotalLayers=" + rootSnapshot.layers.length +
            "\twidth=" + sourceDocument.width.as("px") +
            "\theight=" + sourceDocument.height.as("px")
        );

        if (auditOnly) {
            auditRootPlanIds(sourceDocument, sourceDocument.name);
            if (!sourceDocumentBorrowed) {
                sourceDocument.close(SaveOptions.DONOTSAVECHANGES);
            }
            sourceDocument = null;
            logLine("STATUS=AUDIT_DONE\telapsedMs=" + elapsedMs());
            return;
        }

        auditRootPlanIds(sourceDocument, sourceDocument.name);
        if (!inPlace) {
            exportFlattenedPng(sourceDocument, beforePreviewPath);
            logLine("PREVIEW_BEFORE\t" + beforePreviewPath);
        }

        processDocument(sourceDocument, sourceDocument.name, 0, null);
        if (deleteHiddenLayers || deleteEmptyLayers) {
            var contentLayersChanged = cleanupRootDocumentLayers(sourceDocument);
            if (contentLayersChanged) {
                saveSnapshot = snapshotDocumentState(sourceDocument);
            }
        }
        var uncoveredPlanIds = getUncoveredPlanIds();
        if (uncoveredPlanIds.length > 0) {
            coverageMismatchCount = uncoveredPlanIds.length;
            coverageMismatchPercent = cleanupPlan.recordsRequiredToOpen > 0
                ? (coverageMismatchCount /
                    cleanupPlan.recordsRequiredToOpen) * 100
                : 0;
            coverageAcceptedByPolicy = coveragePolicy === "skip" ||
                (
                    coveragePolicy === "threshold" &&
                    coverageMismatchPercent <= coverageThresholdPercent
                );
            logLine(
                "PREFLIGHT_PLAN\tCOVERAGE_MISMATCH\tuncovered=" +
                uncoveredPlanIds.length +
                "\tpercent=" + coverageMismatchPercent +
                "\tpolicy=" + coveragePolicy +
                "\tthresholdPercent=" + coverageThresholdPercent +
                "\taccepted=" + coverageAcceptedByPolicy +
                "\tids=" + uncoveredPlanIds.slice(0, 20).join(",")
            );
        }
        if (uncoveredPlanIds.length === 0) {
            logLine(
                "PREFLIGHT_PLAN\tCOVERAGE_OK\tprocessed=" +
                cleanupPlan.recordsRequiredToOpen
            );
        }
        restoreDocumentState(
            sourceDocument,
            saveSnapshot,
            inPlace ? "ROOT_BEFORE_IN_PLACE_SAVE" : "ROOT_BEFORE_SAVE_AS"
        );

        if (inPlace) {
            checkCancellation("BEFORE_IN_PLACE_SAVE");
            logLine(
                "IN_PLACE_SAVE\tSTART\tpath=" + sourceFile.fsName
            );
            var inPlaceSaveStartedMs = new Date().getTime();
            sourceDocument.save();
            logLine(
                "IN_PLACE_SAVE\tDONE\tpath=" + sourceFile.fsName +
                "\telapsedMs=" +
                (new Date().getTime() - inPlaceSaveStartedMs)
            );
            sourceDocument.close(SaveOptions.DONOTSAVECHANGES);
            sourceDocument = null;
            logLine(
                "VALIDATION\tSKIPPED\tmode=IN_PLACE_UNVALIDATED"
            );
        } else {
            exportFlattenedPng(
                sourceDocument,
                afterProcessingPreviewPath
            );
            logLine(
                "PREVIEW_AFTER_PROCESSING\t" +
                afterProcessingPreviewPath
            );

            var outputSaveStartedMs = new Date().getTime();
            saveDocumentCopy(sourceDocument, outputFile, true);
            logLine(
                "OUTPUT_SAVE_COMPLETE\t" + outputPath +
                "\telapsedMs=" +
                (new Date().getTime() - outputSaveStartedMs)
            );

            restoreDocumentState(
                sourceDocument,
                saveSnapshot,
                "ROOT_AFTER_SAVE_AS"
            );
            exportFlattenedPng(sourceDocument, afterSavePreviewPath);
            logLine("PREVIEW_AFTER_SAVE\t" + afterSavePreviewPath);

            sourceDocument.close(SaveOptions.DONOTSAVECHANGES);
            sourceDocument = null;

            if (reopenRequired) {
                reopenedOutput = app.open(outputFile);
                var reopenDifferences = compareDocumentState(
                    reopenedOutput,
                    saveSnapshot
                );
                if (reopenDifferences.length > 0) {
                    logLine(
                        "STATE_REOPEN\tMISMATCH\tdifferences=" +
                        reopenDifferences.length +
                        "\t" + reopenDifferences.slice(0, 5).join(" || ")
                    );
                } else {
                    logLine(
                        "STATE_REOPEN\tOK\tlayers=" +
                        saveSnapshot.layers.length
                    );
                }

                exportFlattenedPng(
                    reopenedOutput,
                    afterReopenPreviewPath
                );
                logLine("PREVIEW_AFTER_REOPEN\t" + afterReopenPreviewPath);
                reopenedOutput.close(SaveOptions.DONOTSAVECHANGES);
                reopenedOutput = null;
            } else {
                logLine("STATE_REOPEN\tSKIPPED\tselectedChecks=false");
            }
        }

        var sourceAfter = new File(sourcePath);
        logLine(
            "SOURCE_AFTER\tbytes=" + sourceAfter.length +
            "\tmodified=" + sourceAfter.modified
        );
        logLine(
            "SUMMARY\tvisitedDocuments=" + visitedDocuments +
            "\topenedSmartObjects=" + openedSmartObjects +
            "\tskippedSmartObjects=" + skippedSmartObjects +
            "\tpreflightSkippedSmartObjects=" +
            preflightSkippedSmartObjects +
            "\tsharedSkippedSmartObjects=" +
            sharedSkippedSmartObjects +
            "\tplanIdMatches=" + planIdMatches +
            "\tplanNameFallbackMatches=" +
            planNameFallbackMatches +
            "\tsmartObjectsWithoutAssetId=" +
            smartObjectsWithoutAssetId +
            "\tcrossBitDepthSmartObjectsOpened=" +
            crossBitDepthSmartObjectsOpened +
            "\txmpChecksSkippedByPlan=" +
            xmpChecksSkippedByPlan +
            "\tcleanedDocuments=" + cleanedDocuments +
            "\tfailedSmartObjects=" + failedSmartObjects +
            "\tplannedObjectsCompleted=" + plannedObjectsCompleted +
            "\tplannedObjectsFailed=" + plannedObjectsFailed +
            "\tscannedSmartObjects=" + scannedSmartObjects +
            "\tinitiallyHiddenSmartObjects=" +
            initiallyHiddenSmartObjects +
            "\tinitiallyLockedSmartObjects=" +
            initiallyLockedSmartObjects
        );
        if (
            coverageMismatchCount > 0 &&
            (!coverageAcceptedByPolicy || inPlace)
        ) {
            logLine(
                "STATUS=PARTIAL\tuncovered=" + coverageMismatchCount +
                "\tcoverageMismatchPercent=" + coverageMismatchPercent +
                "\tfailedSmartObjects=" + failedSmartObjects +
                "\telapsedMs=" + elapsedMs()
            );
        } else if (failedSmartObjects > 0 && inPlace) {
            logLine(
                "STATUS=PARTIAL\tuncovered=" + coverageMismatchCount +
                "\tcoverageMismatchPercent=" + coverageMismatchPercent +
                "\tfailedSmartObjects=" + failedSmartObjects +
                "\telapsedMs=" + elapsedMs()
            );
        } else {
            logLine("STATUS=DONE\telapsedMs=" + elapsedMs());
        }
    } catch (fatalError) {
        if (isCancellationError(fatalError)) {
            var partialSaveCompleted = false;
            if (
                inPlace &&
                sourceDocument !== null &&
                !sourceDocumentBorrowed
            ) {
                try {
                    app.activeDocument = sourceDocument;
                    if (rootSnapshot !== null) {
                        restoreDocumentState(
                            sourceDocument,
                            rootSnapshot,
                            "ROOT_BEFORE_CANCEL_PARTIAL_SAVE"
                        );
                    }
                    logLine("IN_PLACE_CANCEL_SAVE\tSTART");
                    sourceDocument.save();
                    logLine("IN_PLACE_CANCEL_SAVE\tDONE");
                    sourceDocument.close(SaveOptions.DONOTSAVECHANGES);
                    sourceDocument = null;
                    partialSaveCompleted = true;
                } catch (partialSaveError) {
                    logLine(
                        "IN_PLACE_CANCEL_SAVE\tERROR\t" +
                        partialSaveError.message +
                        "\tline=" + partialSaveError.line
                    );
                }
            }
            logLine(
                (partialSaveCompleted
                    ? "STATUS=CANCELLED_SAVED\t"
                    : "STATUS=CANCELLED\t") +
                fatalError.message +
                "\tline=" + fatalError.line +
                "\telapsedMs=" + elapsedMs()
            );
        } else {
            logLine(
                "STATUS=ERROR\t" + fatalError.message +
                "\tline=" + fatalError.line +
                "\telapsedMs=" + elapsedMs()
            );
        }
        try {
            if (reopenedOutput !== null) {
                app.activeDocument = reopenedOutput;
                reopenedOutput.close(SaveOptions.DONOTSAVECHANGES);
            }
        } catch (ignoredCloseReopened) {
        }
        try {
            if (
                sourceDocument !== null &&
                !sourceDocumentBorrowed
            ) {
                app.activeDocument = sourceDocument;
                sourceDocument.close(SaveOptions.DONOTSAVECHANGES);
            }
        } catch (ignoredCloseSource) {
        }
    } finally {
        app.displayDialogs = previousDialogs;
        try {
            if (previousDocument !== null) {
                app.activeDocument = previousDocument;
            }
        } catch (ignoredRestorePreviousDocument) {
        }
    }
}(arguments.length > 0 ? arguments[0] : ""));
