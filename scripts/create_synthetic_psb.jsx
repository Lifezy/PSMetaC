#target photoshop

(function (jobPathArgument) {
    function trimText(value) {
        return String(value || "").replace(/^\s+|\s+$/g, "");
    }

    function decodeText(value) {
        try {
            return decodeURIComponent(value);
        } catch (ignoredDecodeError) {
            return value;
        }
    }

    function loadJob(jobPath) {
        var file = new File(String(jobPath || ""));
        if (!file.exists) {
            throw new Error("Synthetic fixture job does not exist: " + jobPath);
        }
        file.encoding = "UTF8";
        if (!file.open("r")) {
            throw new Error("Cannot open synthetic fixture job: " + jobPath);
        }
        var raw = file.read();
        file.close();
        var lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        if (trimText(lines[0]) !== "#PSB_SYNTHETIC_FIXTURE_V1") {
            throw new Error("Invalid synthetic fixture job header");
        }
        var values = {};
        var i;
        for (i = 1; i < lines.length; i++) {
            if (!lines[i]) {
                continue;
            }
            var fields = lines[i].split("\t");
            values[fields[0]] = decodeText(fields.slice(1).join("\t"));
        }
        if (!values.OUTPUT_PATH || !values.LOG_PATH) {
            throw new Error("Synthetic fixture job is missing OUTPUT_PATH or LOG_PATH");
        }
        return values;
    }

    var job = loadJob(jobPathArgument);
    var fixtureMode = job.MODE || "NESTED";
    var output = new File(job.OUTPUT_PATH);
    var logFile = new File(job.LOG_PATH);
    var root = null;
    var logLines = [];

    function log(message) {
        logLines.push(new Date().toUTCString() + "\t" + message);
    }

    function writeLog() {
        var parent = logFile.parent;
        if (!parent.exists) {
            parent.create();
        }
        logFile.encoding = "UTF8";
        logFile.open("w");
        logFile.write(logLines.join("\n") + "\n");
        logFile.close();
    }

    function xmlEscape(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function buildXmp(label, ancestorCount) {
        var items = [];
        var i;
        for (i = 0; i < ancestorCount; i++) {
            items.push(
                "<rdf:li>uuid:" +
                xmlEscape(label) +
                "-" +
                ("000000" + i).slice(-6) +
                "</rdf:li>"
            );
        }
        return [
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"PSB Cleaner synthetic fixture\">",
            "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
            "<rdf:Description rdf:about=\"\" xmlns:photoshop=\"http://ns.adobe.com/photoshop/1.0/\">",
            "<photoshop:DocumentAncestors><rdf:Bag>",
            items.join(""),
            "</rdf:Bag></photoshop:DocumentAncestors>",
            "</rdf:Description></rdf:RDF></x:xmpmeta>",
            "<?xpacket end=\"w\"?>"
        ].join("");
    }

    function setAncestors(document, label, count) {
        document.xmpMetadata.rawData = buildXmp(label, count);
        log(
            "XMP_SET\tdocument=" +
            document.name +
            "\tlabel=" +
            label +
            "\tancestors=" +
            count
        );
    }

    function convertActiveLayerToSmartObject() {
        executeAction(
            app.stringIDToTypeID("newPlacedLayer"),
            undefined,
            DialogModes.NO
        );
    }

    function editActiveSmartObject() {
        executeAction(
            app.stringIDToTypeID("placedLayerEditContents"),
            undefined,
            DialogModes.NO
        );
    }

    function saveAsPsb(document, file) {
        app.activeDocument = document;
        var s2t = function (value) {
            return app.stringIDToTypeID(value);
        };
        var descriptor = new ActionDescriptor();
        descriptor.putObject(
            s2t("as"),
            s2t("largeDocumentFormat"),
            new ActionDescriptor()
        );
        descriptor.putPath(s2t("in"), file);
        descriptor.putBoolean(s2t("copy"), false);
        descriptor.putBoolean(s2t("lowerCase"), true);
        executeAction(s2t("save"), descriptor, DialogModes.NO);
    }

    try {
        log("STATUS=START");
        if (app.documents.length !== 0) {
            throw new Error(
                "PHOTOSHOP_NOT_IDLE: user documents are already open (" +
                app.documents.length +
                ")"
            );
        }
        if (output.exists) {
            throw new Error("OUTPUT_ALREADY_EXISTS: " + output.fsName);
        }
        if (!output.parent.exists && !output.parent.create()) {
            throw new Error("Cannot create output directory: " + output.parent.fsName);
        }

        root = app.documents.add(
            UnitValue(128, "px"),
            UnitValue(128, "px"),
            72,
            "PSB_CLEANER_SYNTHETIC_ROOT",
            NewDocumentMode.RGB,
            DocumentFill.TRANSPARENT,
            1,
            BitsPerChannelType.EIGHT
        );

        var art = root.artLayers.add();
        art.name = "Synthetic pixels";
        var color = new SolidColor();
        color.rgb.red = 32;
        color.rgb.green = 96;
        color.rgb.blue = 180;
        app.foregroundColor = color;
        root.selection.selectAll();
        root.selection.fill(color);
        root.selection.deselect();

        if (fixtureMode === "NESTED") {
            root.activeLayer = art;
            convertActiveLayerToSmartObject();
            root.activeLayer.name = "Embedded level 1";
            editActiveSmartObject();

            var levelOne = app.activeDocument;
            levelOne.activeLayer = levelOne.layers[0];
            convertActiveLayerToSmartObject();
            levelOne.activeLayer.name = "Embedded level 2";
            editActiveSmartObject();

            var levelTwo = app.activeDocument;
            setAncestors(levelTwo, "nested-level-2", 24);
            levelTwo.save();
            levelTwo.close(SaveOptions.SAVECHANGES);

            app.activeDocument = levelOne;
            setAncestors(levelOne, "nested-level-1", 32);
            levelOne.save();
            levelOne.close(SaveOptions.SAVECHANGES);
        } else if (fixtureMode !== "ROOT_ONLY") {
            throw new Error("Unsupported fixture mode: " + fixtureMode);
        }

        app.activeDocument = root;
        setAncestors(root, "root", 40);
        saveAsPsb(root, output);
        log("OUTPUT_PATH=" + output.fsName);
        log("OUTPUT_BYTES=" + output.length);
        log("STATUS=DONE");
    } catch (error) {
        log(
            "STATUS=ERROR\tmessage=" +
            error.message +
            "\tline=" +
            (error.line || "")
        );
        throw error;
    } finally {
        while (app.documents.length > 0) {
            try {
                app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
            } catch (closeError) {
                log("CLOSE_ERROR\t" + closeError.message);
                break;
            }
        }
        writeLog();
    }
}(arguments.length > 0 ? arguments[0] : ""));
