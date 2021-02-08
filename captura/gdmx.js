var db_conf = require('./db_conf');
const fs = require('fs');

var path = require('path');

const ftp = require("basic-ftp")
const ftpHost = process.env.FTP_HOST || 'localhost';
const ftpUser = process.env.FTP_USER || 'test';
const ftpPassword = process.env.FTP_PASSWORD || 'test';
let ftpDirectory = process.env.FTP_DIRECTORY || '/';


const smtpHost = process.env.SMTP_HOST;
const smtpUser = process.env.SMTP_USER;
const smtpPassword = process.env.SMTP_PASSWORD;
const smtpPort = process.env.SMTP_PORT;
const smtpFromEmail = process.env.SMTP_FROM;
const smtpToEmail = process.env.SMTP_TO;

const debug = process.env.debug === 'true';

const nodemailer = require('nodemailer');

const docDirectory = path.join(__dirname, `/gdmx_files`);
console.log('Directorio destino', docDirectory);
const docURL = `${process.env.DOC_URL || ''}/gdmx_files`;
console.log('Url publica', docURL);

console.log(`Inicia la conexion al servidor ftp ${ftpHost}. ${(new Date()).toISOString()}`);

// limpiar log temporal
try{
    db_conf.edca_db.none('delete from log_gdmx');
  
}catch(e) {

}

let client;

let init = async () => {
    client = new ftp.Client();

    if (debug){
        // comentar esto en productivo
        await  db_conf.edca_db.none('delete from documentmanagement');
    }
    

    ftpDirectory = ftpDirectory.replace('.', '');

    // Inicia la conexion al servidor ftp

    try{
        await client.access({
            host: ftpHost,
            user: ftpUser,
            password: ftpPassword
        });
        conexion = true;
    }
    catch(e) {
        console.log('No se ha podido conectar al ftp');
        process.exit(0);
    }


    let registered = await db_conf.edca_db.manyOrNone(`select origin from documentmanagement`) || []; // Carga una lista de las contrataciones generadas

    try{
        // Genera los directorios donde se almacenaran los documentos
        if (!fs.existsSync(docDirectory)) {
            fs.mkdirSync(docDirectory);
        }

        if (!fs.existsSync(docDirectory + '/temp')) {
            fs.mkdirSync(docDirectory + '/temp');
        } else {
            // vaciar archivos que no se han podido eliminar
            deleteFolderRecursive(docDirectory + '/temp');
            fs.mkdirSync(docDirectory + '/temp');
        }
    } catch(e){
        console.log('No se ha podido crear el directorio temporal. Revisar permisos de escritura en servicio GDMX');
        client.close();
        process.exit(0);
    }

    // carga de diccionario
    dictionary = await db_conf.edca_db.manyOrNone('select * from gdmx_dictionary');

    if(dictionary.length === 0) {
        console.log('No se ha cargado el diccionario de datos');
        client.close();
        process.exit(0);
    }

    let files= [];
    try{
        console.log('Inicia busqueda de archivos');
        files = await getFiles();
    }
    catch(e) {
        console.log('No se ha podido listar los archivos del ftp. Hay que volver a ejecutar el servicio para realizar otro intento');
        client.close();
        process.exit(0);
    }


    // Filtra los archivos con extension json y que no esten registrados e ignora todo lo demas
    // files = files.filter((file) => {
    //     return /.+\.json/.test(file.name) && registered.filter((e) => e.origin === file.name).length === 0;
    // });

    if(files.length === 0) {
        console.log('No hay nuevos archivos por descargar.');
        client.close();
        process.exit(0);
        return;
    }


    let total = 0;
    let notificacionMensajes = [];

    // descargar archivos
    while(files.length > 0) {
        let ftpfile = files.shift();
        total++;
        const fileName = new Date().getTime() + total + '.json';
        let pathFile = docDirectory + '/temp/' + fileName;


        console.log('-- Procesando: ' + ftpfile.name);

        // crear temporal
        let wStream;
        try{
            wStream = fs.createWriteStream(pathFile);
        }catch(e) {
            console.log('-- No se ha podido crear archivo temporal: ' + pathFile);
            continue;
        }

        // descargar en temporal
        try{
            await client.download(wStream, combinarPaths(ftpfile.pathFtp, '') + ftpfile.name);
        }
        catch(e){
            console.log('-- Error al descargar', ftpfile.name);
            fs.unlinkSync(pathFile);
            continue;
        }

        let json;
        let errores = [];
        // leer temporal y procesar contratacion
        try{
            let data = fs.readFileSync(pathFile, 'utf8');
            
            try {

                var firstCharCode = data.charCodeAt(0);
                if (firstCharCode == 65279) {
                    data = data.substring(1);
                }

                var re = /\0/g;
                str = data.toString().replace(re, "");
                if (!str || str.length === 0){
                    console.log('---- El archivo que se descargo esta vacio');
                }
                
                json = JSON.parse(str);

            } catch (e) {
                console.log('---- No se ha podido leer el json.', e);
                errores.push(' No se ha podido leer el json. Error: ' + e.message);
            }
          
            if (json){
                try {
                    if(json){
                        const result = await generarContratacion(json, ftpfile.name, ftpfile.pathFtp);
                        if(result.length > 0){
                            errores = errores.concat(result);
                        }
                    }
                    
                } catch (e) {
                    console.log('---- No se ha podido generar la contratacion');
                    errores.push('No se ha podido generar la contratacion');
                }

                await moveFile(ftpfile, errores.length > 0 ? 'fallidos' : 'procesados');
                if (errores.length > 0){
                    notificacionMensajes.push({
                        file: ftpfile.name,
                        errores: errores
                    });
                }
               
            }
            
        }catch(e){
            console.log('-- No se ha podido leer temporal: ', pathFile);
        }
        
        // eliminar una vez leido
        try {
            fs.unlinkSync(pathFile);
        }
        catch (e) {
            console.log('-- Error al eliminar archivo temporal: ' + pathFile);
        }
        console.log('-- Se termino de procesar: ' + ftpfile.name);
    }

    if (notificacionMensajes.length > 0){
        await notificarError(notificacionMensajes);
    }

    console.log('El proceso ha finalizado');

    client.close();
    
    process.exit(0);
}

let notificarError = async (errores) => {
    let mensaje = errores.map(error => {
         return `
            <h4>Error al procesar archivo ${error.file}</h4>
            <ul>
            ${
                error.errores.map(x => `<li>${x}</li>`).join('')
            }
            </ul>
            <hr />
        `;
    }).join();

    
    let transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: false,
        auth: {
            user: smtpUser,
            pass: smtpPassword
        }
    });


    try{
        let result = await transporter.verify();
        if (result){
            result = await transporter.sendMail({
                subject: 'CA: Error al procesar archivo',
                from: smtpFromEmail,
                to: smtpToEmail,
                html: mensaje
            });
            console.log('Se ha enviado una notificacion con los errores.');
        } else {
            console.log('No se ha podido enviar la notificacion.');
        }
        
    
    }
    catch(e){
        console.log('No se ha podido enviar la notificacion. ', e)
    }
   
}

/**
 * Obtener los archivos en las rutas configuradas
 */
let getFiles = async() => {
    let files = [];
    const folders = await db_conf.edca_db.manyOrNone('SELECT name FROM gdmx_folders WHERE active = true ORDER BY name asc');

    if (folders.length === 0){
        // si no se han configurado ninguna carpeta se leerar todos
        console.log('Leyendo archivos en raiz')
        files = await client.list(ftpDirectory);
    } else {
        for(let i =0; i< folders.length; i++){
            const ruta = combinarPaths(ftpDirectory, '' ) + folders[i].name;
            console.log('Leyendo archivos en ' + ruta);
            try{
                let result = await client.list(ruta);
                result.forEach(file => file.pathFtp = ruta);
                if(result !== null){
                    files = files.concat(result);
                }
            }
            catch(e){

            }
            
        }
    }

    return files;
}

let moveFile = async (file, folder) => {
    try{
        const destino = combinarPaths(ftpDirectory, folder);
        await client.ensureDir(destino);
        await client.cd(ftpDirectory);
        await client.rename(combinarPaths(file.pathFtp, '') + file.name, destino + file.name);
    }
    catch(e){
        switch(e.code){
            case 550:
                console.log('-- La cuenta del FTP no tiene acceso para mover los archivos');
            break;
            case 553:
                await client.remove(combinarPaths(file.pathFtp, '') + file.name);
            break;
            default:
                console.log('-- No se ha podido mover el archivo ' + file.name + '. ' + e.message);
            break;
        }
    }
}

let combinarPaths = (txt1, txt2) => {
    return (txt1 + '/' + txt2 + '/').replace(/\\/g,'\/').replace(/\/{2,3}/g,'/');
}

init();

// Genera nuevas contrataciones
let generarContratacion = async function (data, filename, ftpPath) {
    let errores = [];
    console.log('---- Inicia generacion de la contratacion');

    try {
        // Valida si el cuerpo del documento es un json
        if (data.constructor === Object && data != null) {
            if (data.fields != null) {
                let records = {};

                data.jsonFileName = filename;
                data.docURL = data.docURL != null && data.docURL.indexOf('.pdf') === -1 ? data.docURL + '.pdf' : data.docURL; // Corrige el nombre del archivo

                // Agrupa los datos del json en base a la tabla en la que se insertaran
                for(let key in data.fields){
                    let field = data.fields[key];
                    // Se evita ingresar valores vacios o invalidos
                    if (field.value == null || (field.value != null && (field.value === '' || (field.value.constructor === Object && (field.value.val == null || field.value.val === ''))))) {
                        continue;
                    }

                    // Obtiene los datos del diccionario
                    let terms = dictionary.filter((e) => e.variable && (e.variable.trim().toLocaleLowerCase() === field.id.trim().toLocaleLowerCase()));
                    // Se filtran los datos en base al tipo de documento
                    let term = terms.filter((e) => e.document.trim().toLocaleLowerCase() === data.typeDoc.trim().toLocaleLowerCase())[0];
                    
                    if (term != null) {
                        term.tablename = term.tablename.toLocaleLowerCase().trim();
                        records[term.tablename] = records[term.tablename] || (term.index != null ? [] : {});

                        // Agrega las propiedades al objeto resultante
                        if (records[term.tablename].constructor === Array) {
                            records[term.tablename][term.index] = records[term.tablename][term.index] || {};

                            if (field.value.constructor === Object) {
                                field.value = await getValue(term, field.value);
                            }

                            records[term.tablename][term.index][term.field] = { value: (field.value || null), term: term };
                        } else {
                            if (field.value.constructor === Object) {
                                field.value = await getValue(term, field.value);
                            }

                            records[term.tablename][term.field] = { value: (field.value || null), term: term };
                        }
                    } else {
                        continue;
                    }
                };

                let contracting = await generateContractingProcess(data, ftpPath);
                
               

                // Valida que haya datos a actualizar
                if (Object.keys(records).length > 0 && records.constructor === Object) {
                   
                    if (await db_conf.edca_db.oneOrNone('select count(*) from documentmanagement where origin like $1',[data.jsonFileName])){
                        let {id} = await db_conf.edca_db.oneOrNone(`insert into documentmanagement (contractingprocess_id, origin, document, instance_id, type, register_date) values ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) returning id`, [
                            contracting.contractingprocess_id,
                            data.jsonFileName,
                            data.docURL != null ? data.docURL.split('/').pop() : '',
                            data.wfInstanceUuid,
                            data.typeDoc
                        ]);                     
                        console.log('------ Lectura de documento almacenada en documentmanagement: ' + id);
                    } else {
                        db_conf.edca_db.none('update documentmanagement set error = null, register_date=CURRENT_TIMESTAMP where origin like $1', [data.jsonFileName]);
                    }

                    // se procede a registrar los datos
                    let error = await fillContractingProcess(contracting.contractingprocess_id, records);
                    if (error.length > 0) {
                        errores.push('Contratacion con id: ' + contracting.contractingprocess_id)
                        errores = errores.concat(error);
                        db_conf.edca_db.none('update documentmanagement set error = $2, register_date=CURRENT_TIMESTAMP where origin like $1', [data.jsonFileName, error.join(' | ')]);
                    }

                } else {
                    console.log(`------ Se ignoro documento porque no hay variables disponibles por registrar`);
                    errores.push('No se han configurado las variables para este tipo de documento');
                }

                // descargar pdf y registrar registro de documento
                contracting.error = await saveDocument(data, contracting, ftpPath);
                if (contracting.error){
                    errores.push(contracting.error)
                }
            } else {
                console.log('------ La contratacion no tiene campos');
                errores.push('Archivo vacio');
            }
        } else {
            console.log('------ La contratacion no tiene datos');
            errores.push('Archivo vacio');
        }
    } catch (e) {
        console.log('------ Error al generar contratacion', e);
        errores.push('Error desconocido. ' + e.message);
    }

    return errores;
}

let generateContractingProcess = async (data, ftpPath) =>{
    let contracting = await db_conf.edca_db.oneOrNone(`select contractingprocess_id, document from documentmanagement where instance_id = $1 limit 1`, [data.wfInstanceUuid]);

    if (contracting) {
        let selectId = 'SELECT id FROM $1~ WHERE contractingprocess_id = $2 LIMIT 1';
        contracting.award_id = (await db_conf.edca_db.oneOrNone(selectId, ['award',contracting.contractingprocess_id])).id,
        contracting.contract_id = (await db_conf.edca_db.oneOrNone(selectId, ['contract',contracting.contractingprocess_id])).id,
        contracting.implementation_id = (await db_conf.edca_db.oneOrNone(selectId, ['implementation',contracting.contractingprocess_id])).id
        console.log('------ Se detecto actualizacion de contratacion: ', contracting.contractingprocess_id);
    } else {
        contracting = {};
        // Obtiene datos necesario para la contratacion
        const metadata = await db_conf.edca_db.manyOrNone('select * from metadata').then((data) => {
            return data != null ? data.reduce((pv, cv) => {
                pv[cv['field_name']] = cv['value'];

                return pv;
            }, {}) : {};
        });
        const ocid = await getPrefixOCID();

        contracting['contractingprocess_id'] = (await  db_conf.edca_db.oneOrNone(`insert into contractingprocess (fecha_creacion, hora_creacion, ocid, publicationpolicy, license) values (current_date, current_time, $1, $2, $3) returning id`, [
            ocid != null ? ((ocid.value + '-' + data.wfInstanceUuid) || 'CONTRATACION') : 'CONTRATACION',
            metadata != null ? (metadata.politica_url || '') : '',
            metadata != null ? (metadata.licencia_url || '') : ''])).id;

        console.log('------ Contratacion generada con id: ' + contracting['contractingprocess_id'] );


        await  db_conf.edca_db.one(`insert into planning (contractingprocess_id) values ($1) returning id`, [contracting.contractingprocess_id]);
        await db_conf.edca_db.one(`insert into budget (contractingprocess_id, planning_id) values ($1, $2) returning id`, [contracting.contractingprocess_id,contracting.planning]);
        await  db_conf.edca_db.one(`insert into tender (contractingprocess_id) values ($1) returning id`, [contracting.contractingprocess_id]);
        contracting.award_id = (await  db_conf.edca_db.one(`insert into award (contractingprocess_id) values ($1) returning id`, [contracting.contractingprocess_id])).id;
        contracting.contract_id = (await  db_conf.edca_db.one(`insert into contract (contractingprocess_id, awardid) values ($1, $2) returning id`, [contracting.contractingprocess_id, contracting.award_id])).id;
        contracting.implementation_id = (await  db_conf.edca_db.one(`insert into implementation (contractingprocess_id, contract_id) values ($1, $2) returning id`, [contracting.contractingprocess_id, contracting.contract_id])).id;
        await  db_conf.edca_db.one(`insert into publisher (contractingprocess_id) values ($1) returning id`, [contracting.contractingprocess_id]);
        await  db_conf.edca_db.one(`insert into links (contractingprocess_id) values ($1) returning id`, [contracting.contractingprocess_id]);
        await  db_conf.edca_db.one(`insert into tags (contractingprocess_id,planning, stage, register_date) values ($1,true, 1, CURRENT_DATE) returning id`, [contracting.contractingprocess_id]);

    }
    
    return contracting;
}

let saveDocument = async (data, contracting, ftpPath) => {
    let splits = data.docURL.split('/');
    const name =  splits[splits.length-1];

    try{
        const uuid = generateUUID();
      
        
        //let document = documents.find((e) => e.name === data.typeDoc);
        let document = await db_conf.edca_db.oneOrNone('select * from gdmx_document where upper(trim(name)) like $1 limit 1', [data.typeDoc.trim().toUpperCase()]);

        if (document == null) {
            console.log('------ No se ha encontrado el tipo de documento', data.typeDoc);
            await moveFile({
                name: name,
                pathFtp: ftpPath
            }, 'fallidos');
            return 'No se ha encontrado el tipo de documento ' + data.typeDoc;
        }

        let dateMatch = data.docUDate.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})\s([0-9]{2})-([0-9]{2})-([0-9]{2})$/);

        if (await db_conf.edca_db.oneOrNone('select * from $1~ where url like $2 and contractingprocess_id = $3 and $4~ = $5 limit 1', [
            document.tablename,
            data.docURL != null ? `${docURL}/${data.docURL.split('/').pop()}` : null,
            contracting['contractingprocess_id'],
            document.identifier,
            document.stage === 1 ? contracting['planning_id'] : document.stage === 2 ? contracting['tender_id'] : document.stage === 3 ? contracting['award_id'] : document.stage === 4 ? contracting['contract_id'] : document.stage === 5 ? contracting['implementation_id'] : null,
            
        ])) {
            console.log(`------ Ignorando descarga de documento ya registrado`)
            return;
        }

        let registrado = false;
        // Descarga el archivo relacionado al registro
        if (data.docURL != null && data.docURL !== '') {

            if(data.docURL.startsWith('http')){
                registrado = true;
            } else{
               
                try{
                    await downloadFTPFile(combinarPaths(ftpPath, '') + name);
                    await moveFile({
                        name: name,
                        pathFtp: ftpPath
                    }, 'procesados');
                    registrado = true;
                }catch(e) {
                    console.log('------ Error al descargar archivo', name);
                    await moveFile({
                        name: name,
                        pathFtp: ftpPath
                    }, 'fallidos');
                    registrado = true;
                    return 'Error al descargar archivo ' + data.docURL + '. ' + e.message;
                }
            }

           
        }

        if(registrado){
            let id = await db_conf.edca_db.one(`insert into $1~ (contractingprocess_id, $2~, document_type, documentid, url, date_published, format, title, description, language) values ($3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`, [
                document.tablename,
                document.identifier,
                contracting['contractingprocess_id'],
                document.stage === 1 ? contracting['planning_id'] : document.stage === 2 ? contracting['tender_id'] : document.stage === 3 ? contracting['award_id'] : document.stage === 4 ? contracting['contract_id'] : document.stage === 5 ? contracting['implementation_id'] : null,
                document.type,
                `doc-${uuid}`,
                data.docURL != null ? `${docURL}/${data.docURL.split('/').pop()}` : null,
                dateMatch != null ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${dateMatch[4]}:${dateMatch[5]}:${dateMatch[6]}` : new Date().toISOString(),
                document.format,
                document.title,
                document.description,
                document.language
            ]);

            let updateStatus = require('./utilities/changeStatus');

            await updateStatus(contracting['contractingprocess_id'],document.type, document.identifier,document.stage === 1 ? contracting['planning_id'] : document.stage === 2 ? contracting['tender_id'] : document.stage === 3 ? contracting['award_id'] : document.stage === 4 ? contracting['contract_id'] : document.stage === 5 ? contracting['implementation_id'] : null);

            console.log(`-------- Se registro ${document.tablename} con id: ${id.id}` );
        }
    }
    catch(e) {
        console.log(`---------- Error al registrar documento`, e);
        await moveFile({
            name: name,
            pathFtp: ftpPath
        }, 'fallidos');
        registrado = true;
        return 'Error al registrar archivo ' + data.docURL + '. ' + e.message;
    }
}


// Descarga un archivo del servidor ftp
let downloadFTPFile = function (url) {
    const fileName = url.split('/').pop();
    console.log('------ Descargando archivo: ' + url);
    let stream = fs.createWriteStream(docDirectory + '/' + fileName)
    return client.download(stream, url);
}

// Obtiene el template del ocid
let getPrefixOCID = async function () {
    return await db_conf.edca_db.oneOrNone('select * from prefixocid order by id limit 1') || {};
}

// Regresa el valor relacionado a un catalogo
let getValue = async function (term, value) {
    if (term.catalog != null) {
        if(typeof value !== 'object'){
            value = {
                val: value
            };
        }

        let reg = await db_conf.edca_db.oneOrNone(`select $2~ as val from $1~ where $2~ = $3 or $2~ = $4 limit 1`, [term.catalog, term.catalog_field, value.val, value.desc]);

        if (reg != null) {
            return reg.val || null;
        } else {
            return value.desc || null;
        }
    } else {
        return typeof value === 'object' ? value.val || value.desc || null : value;
    }
}

// Genera un identificador unico
let generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

let executeSP = async (id, cpid, obj, sp, callback) => {
    try {
        if(sp){
            await db_conf.edca_db.manyOrNone('SELECT $1~($2, $3, $4)', [sp, cpid, id, obj]);
        }
    } catch (e) {
        console.log('-------- Error al ejecutar SP', sp, e.message);
    }


    if (callback) {
        callback(res);
    }
}

let getJsonValue = (recs) => {
    let obj = {};

    Object.keys(recs).forEach((prop) => {
        let nProp = recs[prop];

        if (nProp && nProp.value != null) {
            if (nProp.term != null) {
                switch (nProp.term.type) {
                    case 'text':
                        nProp.value = nProp.value.trim();
                        break;
                    case 'bool':
                        nProp.value = nProp.value === 'true';
                    case 'date':
                        if(nProp.value.split('/').length > 1){
                            nProp.value = `'${nProp.value.split('/').reverse().join("-")}'`;
                        } else {
                            console.log(`-------- Error en la variable "${prop}" al convertir "${nProp.value}" a fecha`);
                            return;
                        }
                        break;
                    case 'number':
                        nProp.value = nProp.value.replace(/\$|\s|,|%/g,'');
                        if(/\d+(\.\d+)?/.test(nProp.value)){
                            nProp.value = nProp.value.replace(/,/g, '');
                        } else {
                            console.log(`-------- Error en la variable "${prop.key}" al convertir "${nProp.value}" a numero`);
                            return
                        }
                       
                        break;
                }
            }

            if(nProp.value !== undefined){
                obj[prop] = nProp.value
            }
            
        }
    });

    return obj
}

// si necesitan mas tablas solo agregenlas aqui
let tables = 
[
    { name: 'award', identifier: 'awardid', parents: ['contractingprocess_id'] , order: 19},
    { name: 'awardamendmentchanges', identifier: 'amendments_id', parents: ['contractingprocess_id', 'award_id'] , order: 20},
    { name: 'awarddocuments', identifier: 'documentid', parents: ['contractingprocess_id', 'award_id'] , order: 21},
    { name: 'awarditem', identifier: 'classification_id', parents: ['contractingprocess_id', 'award_id'] , order: 22, searchFk: []},
    { name: 'budget', identifier: 'budget_budgetid', parents: ['contractingprocess_id', 'planning_id'] , order: 9},
    { name: 'budgetbreakdown', identifier: 'description', parents: ['contractingprocess_id', 'planning_id'] , order: 10, searchFk: ['source_id']},
    { name: 'budgetclassifications', identifier: 'cve', parents: ['budgetbreakdown_id'] , order: 11, searchFk: ['budgetbreakdown_id']},
    { name: 'clarificationmeeting', identifier: 'clarificationmeetingid', parents: ['contractingprocess_id'] , order: 4},
    { name: 'contract', identifier: 'contractid', parents: ['contractingprocess_id'] , order: 25, searchFk: ['awardID']},
    { name: 'contractamendmentchanges', identifier: 'amendments_id', parents: ['contractingprocess_id', 'contract_id'] , order: 26},
    { name: 'contractdocuments', identifier: 'documentid', parents: ['contractingprocess_id', 'contract_id'] , order: 27},
    { name: 'contractingprocess', identifier: 'ocid', parents: [], onlyUpdate: true , order: 1},
    { name: 'contractitem', identifier: 'classification_id', parents: ['contractingprocess_id', 'contract_id'] , order: 28, },
    { name: 'guarantees', identifier: 'guarantee_id', parents: ['contractingprocess_id', 'contract_id'] , order: 30, searchFk: ['guarantor'] },
    { name: 'implementation', identifier: undefined, parents: ['contractingprocess_id', 'contract_id'], onlyUpdate: true , order: 31},
    { name: 'implementationdocuments', identifier: 'documentid', parents: ['contractingprocess_id', 'contract_id' , 'implementation_id'] , order: 32},
    { name: 'implementationmilestone', identifier: 'milestoneid', parents: ['contractingprocess_id', 'contract_id', 'implementation_id'] , order: 33},
    { name: 'implementationmilestonedocuments', identifier: 'documentid', parents: ['contractingprocess_id', 'contract_id', 'implementation_id'] , order: 34},
    { name: 'implementationtransactions', identifier: 'transactionid', parents: ['contractingprocess_id', 'contract_id', 'implementation_id'] , order: 35, searchFk: ['payer_id', 'payee_id']},
    { name: 'parties', identifier: 'identifier_id', parents: ['contractingprocess_id'] , order: 6},
    { name: 'partiesadditionalidentifiers', identifier: undefined, parents: ['contractingprocess_id', 'parties_id'], onlyUpdate: true , order: 7},
    { name: 'planning', identifier: undefined, parents: ['contractingprocess_id'], onlyUpdate: true , order: 2},
    { name: 'planningdocuments', identifier: 'documentid', parents: ['contractingprocess_id', 'planning_id'] , order: 3},
    { name: 'publisher', identifier: 'uid', parents: ['contractingprocess_id'] , order: 2},
    { name: 'quotes', identifier: 'quotes_id', parents: ['requestforquotes_id'] , order: 6, searchFk: ['requestforquotes_id','issuingsupplier_id']},
    { name: 'quotesitems', identifier: 'itemid', parents: ['quotes_id'], order: 7, searchFk: ['quotes_id']},
    { name: 'relatedprocedure', identifier: 'relatedprocedure_id', parents: ['contractingprocess_id'] , order: 36, searchFk: ['contractingprocess_id']},
    { name: 'requestforquotes', identifier: 'requestforquotes_id', parents: ['contractingprocess_id', 'planning_id'] , order: 4},
    { name: 'requestforquotesitems', identifier: 'itemid', parents: ['requestforquotes_id'] , order: 5 , searchFk: ['requestforquotes_id']},
    { name: 'tender', identifier: undefined, parents: ['contractingprocess_id'], onlyUpdate: true , order: 11, searchFk: []},
    { name: 'tenderamendmentchanges', identifier: 'amendments_id', parents: ['contractingprocess_id', 'tender_id'] , order: 12, searchFk: []},
    { name: 'tenderdocuments', identifier: 'documentid', parents: ['contractingprocess_id', 'tender_id'] , order: 13, searchFk: []},
    { name: 'tenderitem', identifier: 'classification_id', parents: ['contractingprocess_id', 'tender_id' ] , order: 14},
    { name: 'tendermilestone', identifier: 'milestoneid', parents: ['contractingprocess_id', 'tender_id'] , order: 16, searchFk: []}
];

// aqui se iran almacenando en memoria
let schemas = {};


const getSchema = async table => {
    if(!schemas[table]) {
        schemas[table] =  db_conf.edca_db.many("select distinct column_name, data_type from INFORMATION_SCHEMA.COLUMNS where table_name = $1 and table_schema = 'public';", [table]);
    }
    return schemas[table];
}


let fillContractingProcess = async (cpid, records) => {
    let hayError = [];
    let selectId = 'SELECT id FROM $1~ WHERE contractingprocess_id = $2 LIMIT 1';
    // se contruye contratacion con ids a registros base
    let contracting = {
        contractingprocess_id : cpid
    };
    contracting.planning_id = (await db_conf.edca_db.oneOrNone(selectId, ['planning',cpid])).id,
    contracting.tender_id = (await db_conf.edca_db.oneOrNone(selectId, ['tender',cpid])).id,
    contracting.award_id = (await db_conf.edca_db.oneOrNone(selectId, ['award',cpid])).id,
    contracting.contract_id = (await db_conf.edca_db.oneOrNone(selectId, ['contract',cpid])).id,
    contracting.implementation_id = (await db_conf.edca_db.oneOrNone(selectId, ['implementation',cpid])).id
    
    tables = tables.sort((a,b) => {
        if(a.order > b.order) {
            return 1;
        } else {
            return -1;
        }
    })


    for(let index in tables) {
        let table = tables[index].name;
        let data = records[table];

        if(data){
            let items = Array.isArray(data) ? data : [data];

            for(let i in items) {
                let current = items[i];
                let keys = Object.keys(current);
                let sp = keys.map(x => current[x].term && current[x].term.storeprocedure).find(x => x !== undefined && x!== null && x!==false);
                let result = await insertOrUpdate(getJsonValue(current),cpid, table,sp, contracting, hayError);
                if(result) {
                    current.id = result.id;
                    if(table === 'parties'){
                        let role = keys.map(x => current[x].term && current[x].term.classification).find(x => x !== undefined && x!== null && x!=='');
                        let parent = keys.map(x => current[x].term && current[x].term.parent).find(x => x !== undefined && x!== null && x!=='');
                        if(role){
                            role = role.trim().toLocaleLowerCase();
                            await addRole(result, role, hayError, cpid);
                            await addExtraOnParties(current.id, contracting, role, records, parent, hayError);
                        }
                        


                    }
                }
            }
            delete records[table];
        }

    }

    let sobrantes = Object.keys(records);
    if(sobrantes.length > 0){
        console.log(`-------- Ejecutando tablas no disponibles: "${sobrantes.join(', ')}".`);
        for(let i in records) {
            let current = records[i];
            let keys = Object.keys(current);
            let sp = keys.map(x => current[x].term && current[x].term.storeprocedure).find(x => x !== undefined && x!== null && x!==false);
            if(sp){
                await insertOrUpdate(getJsonValue(current),cpid, i,sp, contracting, hayError);
                console.log(`---------------- Se ejecuto ${sp}.`);
            }
            
        }
    }

    return hayError;
}

let addRole = async (res, role, hayError, cpid) => {
    let roles = await db_conf.edca_db.oneOrNone('select * from roles where parties_id = $1 LIMIT 1', [res.id]);
    try{
        if(!roles) {
            await db_conf.edca_db.none(`insert into roles(parties_id, ${role}, contractingprocess_id) VALUES($1, true, $2)`, [res.id, cpid]);
        } else {
            await db_conf.edca_db.none(`update  roles set  ${role} = true where parties_id = $1`, [res.id]);
        }
    }
    catch(err) {
        hayError.push(`Error al registar rol ${role}. `);
        console.log(`---------------- Error al registar rol ${role}`);
    }
}

let addExtraOnParties = async(id, contracting, role, records, parent, hayError) => {
    try{
            switch(role.toLocaleLowerCase()){
                case 'invitedsupplier':
                        if(!contracting.requestforquotes_id) {
                            contracting.requestforquotes_id = (await one('select id from requestforquotes where  contractingprocess_id = $1 limit 1', [contracting.contractingprocess_id])).id;
                        }
                        await db_conf.edca_db.one(`insert into requestforquotesinvitedsuppliers (requestforquotes_id, parties_id) values ($1, $2) returning id`, [contracting.requestforquotes_id, id]);
                        break;
                    case 'issuingsupplier':
                        if(!contracting.quote_id) {
                            contracting.quote_id = (await one('select id from quotes where requestforquotes_id in (select id from requestforquotes where  contractingprocess_id = $1) limit 1', [contracting.contractingprocess_id])).id;
                        }
                        await db_conf.edca_db.none(`update quotes set issuingsupplier_id = $2 where id = $1 and issuingsupplier_id is null`, [contracting.quote_id, id]);
                        break;
                    case 'clarificationmeetingofficial':
                        if(!contracting.clarificationmeeting_id) {
                            contracting.clarificationmeeting_id = (await one('select id from clarificationmeeting where contractingprocess_id = $1', [contracting.contractingprocess_id])).id;
                        }
                        await db_conf.edca_db.one(`insert into clarificationmeetingactor (clarificationmeeting_id, parties_id, attender, official) values ($1, $2, $3, $4) returning id`, [contracting.clarificationmeeting_id, id, role === 'enquirer', role === 'clarificationmeetingofficial']);
                        break;
                    case 'enquirer':
                        if(!contracting.clarificationmeeting_id) {
                            contracting.clarificationmeeting_id = (await one('select id from clarificationmeeting where contractingprocess_id = $1 limit 1', [contracting.contractingprocess_id])).id;
                        }
                        await db_conf.edca_db.one(`insert into clarificationmeetingactor (clarificationmeeting_id, parties_id, attender, official) values ($1, $2, $3, $4) returning id`, [contracting.clarificationmeeting_id, id, role === 'enquirer', role === 'clarificationmeetingofficial']);
                        break;
                    case 'tenderer':
                        if (parent) {
                             await db_conf.edca_db.one(`insert into memberof (principal_parties_id, parties_id) values ($1, $2) returning id`, [records.parties[parent].id, id]);
                        }
                        await one('update tender set numberoftenderers = (select count(*) from parties p join roles r on r.parties_id = p.id where r.tenderer = true and p.contractingprocess_id = tender.contractingprocess_id) where id = $1',[contracting.tender_id]);
                        break;
                    case 'supplier':
                        await db_conf.edca_db.one(`insert into awardsupplier (award_id, parties_id) values($1, $2) returning id`, [contracting.award_id, id]);
                        break;
                    case 'requestingunit':
                    case 'contractingunit':
                    case 'technicalunit':
                        await one(`UPDATE parties SET identifier_scheme = CASE WHEN EXISTS(SELECT * FROM roles WHERE roles.parties_id = parties.id AND (requestingunit = true OR  contractingunit = true OR  technicalunit = true)) THEN 'MX-INAI' ELSE 'MX-RFC' END WHERE id = $1`, [id]);

                        // req 3.identifier
                        await one(`UPDATE parties SET partyid = identifier_scheme || '-' || identifier_id
                                    WHERE id = $1`, [id]);
                    break;
            }
        }
        catch(e){
            hayError.push( e.message + '. ' );
        }
}


let insertOrUpdate = async (obj, cpid, table, sp, parent, hayError) =>{
   
    try{
        table = table.trim().toLocaleLowerCase();
        const configTable = tables.find(x => x.name === table);
        // pk real
        let id;

        if(configTable) {

            
            let fields = await getSchema(table);
            let fieldsFromObject = Object.keys(obj);
            let fieldToImport = [];
            let fieldsIgnored = [];

            // al inicio de los parametros se agrega la tabla
            let params = [table],
                paramsSelect =[table]
                stringWhereSelect = [];

            // validar campos
            for( let x = 0; x < fieldsFromObject.length ; x++){
                let key = fieldsFromObject[x].toLocaleLowerCase().trim();
                if(fields.find(y => y.column_name === key) && 
                                    !configTable.parents.includes(key)) {

                    // intentar obtener llaves foraneas para determinados campos
                    let value = await findFK(cpid,key, obj[key], configTable.searchFk);
                    if (value !== undefined && value !== null) {
                        params.push(value)
                        fieldToImport.push(key);
                    }
                   
                } else {
                    fieldsIgnored.push(key);
                }
            };

            if(fieldToImport.length > 0) {

                if(configTable.identifier && obj[configTable.identifier]){
                    stringWhereSelect.push(`(${configTable.identifier}=$${paramsSelect.length+2} or ${configTable.identifier} is null)`);
                    paramsSelect.push(configTable.identifier)
                    paramsSelect.push(obj[configTable.identifier])
                } 
               
                if(configTable.parents && configTable.parents.length > 0) {
                    // se agregan fk al final
                    for(let i = 0; i < configTable.parents.length; i++){
                        let x = configTable.parents[i];
                        let valueParent = parent[x];
                        if(!valueParent) {
                            valueParent = await findFK(cpid, x, obj[x], [x]);
                        }

                        if(valueParent){
                            let value;
                            if(typeof valueParent === 'object'){
                                let p = valueParent.find(y => y.value === configTable.identifier);
                                value = p ? p.id : undefined;
                            } else {
                                value = valueParent;
                            }

                            if(value){
                                // parametros para select
                                stringWhereSelect.push(`${x}=$${paramsSelect.length + 1}`);
                                paramsSelect.push(valueParent);

                                // parametro para insert/update
                                params.push(valueParent);

                                // campo a utilizar
                                fieldToImport.push(x);
                            } else {
                                console.log(`---------------- No se ha encontrado el valor de la fk "${x}" en la tabla ${table}.`);
                            }
                        } else {
                            console.log(`---------------- No se ha encontrado la fk "${x}" en la tabla ${table}. Debe ejecutar un SP para corregir el registro`);
                        }
                    }
                   
                }

                 // si tiene indetificador se reviza si existe el registro
                let exists = (configTable.identifier && obj[configTable.identifier]) ? 
                                await db_conf.edca_db.oneOrNone(`SELECT $2~ id, count(*) total FROM $1~ WHERE ${ stringWhereSelect.join(' AND ') } GROUP BY $2~ LIMIT 1`, 
                                                                paramsSelect) : 
                                {total: 0};

                

                if(configTable.onlyUpdate) {
                    exists = await db_conf.edca_db.oneOrNone(`SELECT count(*) total FROM $1~ WHERE ${ stringWhereSelect.join(' AND ') }`, 
                    paramsSelect);
                }

               
                if(!exists || exists.total === 0) {

                    await generateIdentificador(obj,table, fieldToImport, params);

                    // proceso para insertar
                    let stringFields = fieldToImport.join(','),
                            stringValues = fieldToImport.map((x, i) => '$'+ (i+ 2)).join(', ');
                    id = (await db_conf.edca_db.oneOrNone(`INSERT INTO $1~(${stringFields}) VALUES(${stringValues}) returning id;`, params)).id;
                    console.log(`-------- Se inserto en "${table}" con id ${id}`);
                } else {
                    // proceso para actualizar
                    if(exists.total > 1) {
                        throw new Error('Existen varios registros con el mismo ID. Revisa la configuracion.');
                    } else {

                        id = (await db_conf.edca_db.oneOrNone(`SELECT id FROM $1~ WHERE ${ stringWhereSelect.join(' AND ') } LIMIT 1`, paramsSelect)).id;

                        params.push(id);

                        let stringValues = fieldToImport.map((x, i) => {
                            return `${x}=$${(i+2)}`;
                        }).join(', ');

                        await db_conf.edca_db.oneOrNone(`UPDATE  $1~ SET ${stringValues} WHERE id = $${params.length}`, params);
                        console.log(`-------- Se actualizo en "${table}" con id ${id}`);
                    }
                }
            } else {
                console.log(`-------- Se han ignorado los siguientes campos: "${fieldsIgnored.join(', ')}" de la tabla "${table}". Revisa la configuracion.`);
            }

        } else {
            console.log(`-------- La tabla "${table}" no esta en el catalogo de tablas disponibles`);
        }
        
        try{
            // hacer ajustes despues del registro
            await postProcess(id, table, obj, cpid);
        }
        catch(e) {

        }
        

        if(sp) {
            await executeSP(id, cpid, obj, sp);
        }

        let result = {
            id: id,
            identifier: configTable ? configTable.identifier : undefined,
            value: configTable ? obj[configTable.identifier]: undefined
        };

        return result;
    }
    catch(e) {
        hayError.push(`Error al registar/actualizar en "${table}", Data:${JSON.stringify(obj)}, Error: ${e.message}. "`);
        console.log(`-------- Error al registar/actualizar en "${table}":`);
        console.log(`---------------- Objeto: ${JSON.stringify(obj)}`);
        console.log(`---------------- Error: ${e.message}`);
    }
}

let generateIdentificador = async (obj, table, fields, values) => {
    switch(table) {
        case 'awarddocuments':
        case 'contractdocuments':
        case 'planningdocuments':
        case 'implementationdocuments':
        case 'tenderdocuments':
            if(!obj.documentid) {
                fields.push('documentid');
                values.push('doc-' + generateUUID());
            }
        break;
        case 'awarditem':
        case 'contractitem':
        case 'tenderitem':
            if(!obj.itemid) {
                fields.push('itemid');
                values.push('item-' + generateUUID());
            }
        break;
        case 'implementationmilestone':
        case 'tendermilestone':
            if(!obj.milestoneid) {
                fields.push('milestoneid');
                values.push('milestone-' + generateUUID());
            }
        break;
        case 'implementationtransactions':
            if(!obj.transactionid) {
                fields.push('transactionid');
                values.push('transaction-' + generateUUID());
            }
        break;
       
        case 'requestforquotes':
            if(!obj.requestforquotes_id) {
                fields.push('requestforquotes_id');
                values.push('request-' + generateUUID());
            }
        break;
        case 'quotes':
            if(!obj.quotes_id) {
                fields.push('quotes_id');
                values.push('quote-' + generateUUID());
            }
        break;
        case 'guarantees':
            if(!obj.guarantee_id) {
                fields.push('guarantee_id');
                values.push('guarantee-' + generateUUID());
            }
        break;
        case 'clarificationmeeting':
            if(!obj.clarificationmeetingid) {
                fields.push('clarificationmeetingid');
                values.push('clarificationMeeting-' + generateUUID());
            }
        break;

    }
}


let postProcess = async (id, table, obj, cpid) => {
    switch(table) {
        case 'budgetclassifications':
            let classification = await one('select * from budgetclassifications where id = $1 limit 1', [id]);
            if(classification){


                await one(`update budgetclassifications
                            SET branch=ps.branch, responsibleunit=ps.responsibleunit, finality=ps.finality, function=ps.function, 
                            subfunction=ps.subfunction, institutionalactivity=ps.institutionalactivity, budgetprogram=ps.budgetprogram, 
                            strategicobjective=ps.strategicobjective, spendingtype=ps.spendingtype, budgetsource=ps.budgetsource, region=ps.region, 
                            portfoliokey=ps.portfoliokey, approved=ps.approvedamount, modified=ps.modifiedamount, executed=ps.executedamount, committed=ps.committedamount, 
                            reserved=ps.reservedamount, cve=ps.cve
                            from programaticstructure ps 
                            where (ps.requestingunit = budgetclassifications.requestingunit and ps.specificactivity = budgetclassifications.specificactivity and ps.spendingobject = budgetclassifications.spendingobject)
                            and  budgetclassifications.id = $1`, [id]);

                await one(`update budgetbreakdown 
                set budgetbreakdown_id = (select string_agg(cve, ',') from budgetclassifications where budgetbreakdown_id = $1), 
                amount = (select round(sum(approved), 2) from budgetclassifications where budgetbreakdown_id = $1) 
                where id = $1`, [classification.budgetbreakdown_id]);
            }
            
        break;
        case 'contract':
            if((await one('select id from implementation where contract_id = $1', [id])) === null) {
                await one('insert into implementation (contract_id, contractingprocess_id) values($1, $2)', [id, cpid])
            }

            // req relacion montos
            await one('update contract set value_amount = exchangerate_amount where exchangerate_amount is not null and (value_amount is null or value_amount = 0) and id =$1',[id]);
            await one('update contract set exchangerate_amount = value_amount where value_amount is not null and (exchangerate_amount is null or exchangerate_amount = 0) and id =$1',[id]);
        break;
        case "parties":
            // req 4, 5
            await one(`UPDATE parties set name = 
                CASE when (givenname IS NOT NULL AND (surname IS NOT NULL OR additionalsurname IS NOT NULL)) AND identifier_legalname IS NULL
                THEN trim(COALESCE(givenname,'') || ' ' || COALESCE(surname, '') || ' ' || COALESCE(additionalsurname,'')) 
                ELSE identifier_legalname END,
                naturalperson = CASE WHEN (givenname IS NOT NULL AND (surname IS NOT NULL OR additionalsurname IS NOT NULL)) AND identifier_legalname IS NULL THEN true ELSE false END
                 WHERE id = $1`, [id]);


            // req 2.schema
            await one(`UPDATE parties SET identifier_scheme = CASE WHEN EXISTS(SELECT * FROM roles WHERE roles.parties_id = parties.id AND (requestingunit = true OR  contractingunit = true OR  technicalunit = true)) THEN 'MX-INAI' ELSE 'MX-RFC' END WHERE id = $1`, [id]);

            // req 3.identifier
            await one(`UPDATE parties SET partyid = identifier_scheme || '-' || identifier_id
                        WHERE id = $1`, [id]);
        break;
        case 'contractitem': 
        case 'awarditem':
        case 'tenderitem':
           
            if (!obj.classification_scheme || obj.classification_scheme === ''){
                 // 9.1
                await one(`update $1~ set classification_scheme = 'CUCOP' where $1~.id = $2`,[table, id]);
            }
            // 9.2
            await one(`update $1~ set classification_description = item.description, unit_name = item.unit
                        from item
                        where classification_id like classificationid and $1~.id = $2`,[table, id]);
           
        break;
        case "requestforquotes":
            await one("update quotes set requestforquotes_id = $1 where requestforquotes_id is null", [id]);

            await db_conf.edca_db.none(`insert into requestforquotesinvitedsuppliers (requestforquotes_id, parties_id)
                                        select $1, p.id
                                        from parties p
                                        join roles r ON r.parties_id = p.id
                                        where (r.invitedsupplier = true or r.supplier = true) and p.id not in 
                                        (select parties_id from requestforquotesinvitedsuppliers where requestforquotes_id = $1)
                                        and p.contractingprocess_id = $2`, [id, cpid]);
        break;
        case "quotes":
            await db_conf.edca_db.one(`update quotes set issuingsupplier_id = (
                select p.id
                from parties p
                join roles r ON r.parties_id = p.id
                where (r.issuingsupplier = true)
                and p.contractingprocess_id = $2 
                limit 1
                ) where id = $1 and issuingsupplier_id is null`, [id, cpid]);
        break;
        case "quotesitems":
            if(obj.item) {
                await one(`update quotesitems set item = $2, itemid=$2 where id = $1`, [id, obj.item]);
                await db_conf.edca_db.none('update quotes set value = (select sum(quotesitems.quantity) from quotesitems where quotes.id = quotesitems.quotes_id)');
            }
            
        break;
        case 'tender':
            await one('update tender set numberoftenderers = (select count(*) from parties p join roles r on r.parties_id = p.id where r.tenderer = true and p.contractingprocess_id = tender.contractingprocess_id) where id = $1',[id]);

            // req 6
            await one(`update tender set procurementmethod = 
                        case when procurementmethod_details like 'Licitación pública' then 'open'
                         when procurementmethod_details like 'Adjudicación directa art.41' then 'direct'
                         when procurementmethod_details like 'Adjudicación directa art.42' then 'direct'
                         when procurementmethod_details like 'Excepciones al reglamento' then 'direct'
                         when procurementmethod_details like 'Convenio de colaboración' then 'direct'
                         when procurementmethod_details like 'Adhesiones y membresías' then 'direct'
                         when procurementmethod_details like 'Invitación a cuando menos tres personas' then 'selective'
                        end
                        where id = $1`, [id]);
            // req 7
            await one(`update tender set procurementmethod_rationale = 
                                    case when procurementmethod_details like 'Excepciones al reglamento' AND procurementmethod_rationale_id like 'Artículo 1 RAAS' then 'Se propone que se realice un procedimiento de contratación, de conformidad con lo dispuesto en el artículo 1 del Reglamento de Adquisiciones, Arrendamientos y Servicios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Convenio de colaboración' AND procurementmethod_rationale_id like 'Artículo 1 RAAS' then 'Se propone que se realice un procedimiento de contratación, de conformidad con lo dispuesto en el artículo 1 del Reglamento de Adquisiciones, Arrendamientos y Servicios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción I RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción I del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción II RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción II del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción III RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción III del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción IV RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción IV del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción V RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción V del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción VI RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción VI del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción VII RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción VII del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción VIII RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción VIII del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción IX RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción IX del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción X RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción X del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción XI RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción XI del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 41 fracción XII RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 41 fracción I del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Invitación a cuando menos tres personas' AND procurementmethod_rationale_id like 'Artículo 42 RAAS ITP' then 'Se propone que se realice un procedimiento de contratación de invitación a cuando menos tres personas, de conformidad con lo dispuesto en el artículo 42 del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción I RAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción I del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción II RAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción II del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción III RAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción III del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción IV RAAS AD' then 'Se propone que se realice un procedimiento de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción IV del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción V RAAS AD' then 'Se propone que se realice un procedimiento de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción V del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción VI RAAS AD' then 'Se propone que se realice un procedimiento de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción VI del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción VII RAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción VII del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción VIII RAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción VIII del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción IX RAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción IX del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción X RAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción X del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción XI RAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción XI del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.41' AND procurementmethod_rationale_id like 'Artículo 41 fracción XII RAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 41 fracción XII del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Adjudicación directa art.42' AND procurementmethod_rationale_id like 'Artículo 42 fracciónRAAS AD' then 'Se propone que se realice un procedimiento de contratación de adjudicación directa, de conformidad con lo dispuesto en el artículo 42 del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                        when  procurementmethod_details like 'Licitación pública' AND procurementmethod_rationale_id like 'Artículo 26 fracción I RAAS' then 'Se propone que se realice un procedimiento de contratación de licitación pública, de conformidad con lo dispuesto en el artículo 26 fracción I del Reglamento de Adquisiciones, Arrendamientos y Servcios del Instituto Nacional de Transparencia, Acceso a la Información y Protección de Datos Personales'
                                    end
                                    where id = $1`,[id]);
                // req 8
                await one(`update tender set mainprocurementcategory = 
                            case when additionalprocurementcategories like 'Adquisición de bienes' then 'goods'
                                when additionalprocurementcategories like 'Arrendamiento de bienes' then 'goods'
                                when additionalprocurementcategories like 'Servicios' then 'services'
                                when additionalprocurementcategories like 'Servicios relacionados con obras públicas' then 'services'
                                when additionalprocurementcategories like 'Obras públicas' then 'works'
                                else 'additionalprocurementcategories'
                            end
                            where id = $1`, [id]);
        break;
    }
}

let one = async function(query, params) {
    return await db_conf.edca_db.oneOrNone(query, params);
};

let findFK = async (cpid, field, value, validFields) => {
    let id;

    if (validFields && validFields.includes(field)) {
        try{
            switch(field) {
                case 'award_id':  id = await one('select id from award where contractingprocess_id = $1 limit 1', [cpid]); break;
                case 'awardID': 
                if (value){
                    id = await one('select id from award where contractingprocess_id = $1 and awardid = like $2 limit 1', [cpid, value]);
                    if (id) {
                        await one('insert into award(contractingprocess_id, awardid) values($1, $2) returning id', [cpid, value]);
                    }
                }
                break;
                case 'planning_id': id = await one('select id from planning where contractingprocess_id = $1 limit 1', [cpid]);break;
                case 'budgetbreakdown_id': 
                if(value) {
                    id= await one('select id from budgetbreakdown where contractingprocess_id = $1 and description like $2 limit 1', [cpid, value]);
                    if(!id) {
                        id = await one('insert into budgetbreakdown(contractingprocess_id, planning_id, description) select contractingprocess_id, id, $2 from planning where contractingprocess_id = $1 returning id', [cpid, value]);
                    }
                } else {
                    id= await one('select id from budgetbreakdown where contractingprocess_id = $1 and not exists (select * from budgetclassifications where budgetbreakdown_id = budgetbreakdown.id) order by id limit 1', [cpid]);
                    if(!id) {
                        await one('select id from budgetbreakdown where contractingprocess_id = $1 limit 1', [cpid]);
                    }
                    
                }
            
                break;
                case 'contract_id': id = await one('select id from contract where contractingprocess_id = $1 limit 1', [cpid]);break;
                case 'contractingprocess_id': id = await one('select id from contractingprocess where ocid like $1 limit 1', [value]);break;
                case 'implementation_id': id = await one('select id from implementation where contractingprocess_id = $1 limit 1', [cpid]);break;
                case 'parties_id': id = await one('select id from parties where contractingprocess_id = $1 limit 1', [cpid]);break;
                case 'issuingsupplier_id': 
                case 'source_id':
                case 'guarantor':
                case 'payer_id':
                case 'payee_id':
                    if(value) {
                        id = await one('select id from parties where contractingprocess_id = $1 and identifier_id = $2  limit 1', [cpid, value]);
                        if (!id) {
                            id = await one('insert into parties (contractingprocess_id,identifier_id) values($1,$2) returning id', [cpid, value]);
                        }

                        if (id && field === 'issuingsupplier_id') {
                            await addRole(id, 'issuingsupplier', [], cpid);
                            await addRole(id, 'invitedsupplier', [], cpid);
                        }
                    }
                break;
                case 'requestforquotes_id': 
                if(value) {
                    id = await one('select id from requestforquotes where contractingprocess_id = $1 and requestforquotes_id like $2 limit 1', [cpid, value]);
                    if(!id) {
                        id = await one('insert into requestforquotes(contractingprocess_id, requestforquotes_id) values($1, $2) returning id', [cpid, value]);
                    }
                } else {
                    id = await one('select id from requestforquotes where contractingprocess_id = $1 limit 1', [cpid]);
                }
                break;
                case 'quotes_id': 
                if(value) {
                    id = await one('select id from quotes where requestforquotes_id in ( select id from requestforquotes where contractingprocess_id = $1) and quotes_id like $2 limit 1', [cpid, value]);
                    if (!id) {
                        id = await one('insert into quotes(requestforquotes_id, quotes_id)  select id, $2 from requestforquotes where contractingprocess_id = $1 limit 1 returning id', [cpid, value]);
                    }
                } else {
                    id = await one('select id from quotes where requestforquotes_id in ( select id from requestforquotes where contractingprocess_id = $1) limit 1', [cpid]);
                }
                break;
                case 'tender_id': id = await one('select id from tender where contractingprocess_id = $1 limit 1', [cpid]);
                case 'itemid':
                case 'classification_id':
                    id = await one('select classificationid from item where classificationid like $1 OR description like $1 limit 1', [value]);
                break;
                default: return value;
            }
    
       
            return id ? id.id : undefined;
        }
        catch(e) {
            return value;
        }
    } else 
        return value;

}


var deleteFolderRecursive = function(path) {
    if( fs.existsSync(path) ) {
      fs.readdirSync(path).forEach(function(file,index){
        var curPath = path + "/" + file;
        if(fs.lstatSync(curPath).isDirectory()) { // recurse
          deleteFolderRecursive(curPath);
        } else { // delete file
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(path);
    }
  };