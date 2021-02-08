const {
	isNotNullOrEmpty, 
    validateRelationBetweenAdditionalProcurementCategoriesAndMainProcurementCategory,
    validateRelationBetweenProcurementMethodDetailsAndProcurementMethod,
    validateProcurementMethodDetails,
    validateTypeOfDocument,
    validateUniqueId,
    getSpanishMainProcurementCategory} = require('../utilities/validation-rules');

const {getValueStatus, TypesOfStatus} = require('../utilities/status');

/**
 * Validación de un proceso
 *
 * @param {Number} cpid ID del contractingprocess
 * @param {IDBDatabase} db Instancia de la base de datos
 */
function ValidateProcess(cpid, db) {
    const _cpid = cpid;
    const _db = db;
    let errs = 0, warns = 0;
    
    /**
     *  Validar todo el proceso
     */
    this.validate = async function(){
        let log = await _db.oneOrNone('select release_json json from logs where contractingprocess_id = $1 order by id desc limit 1', [_cpid]);
        if(!log || !log.json) throw Error('Es necesario generar la entrega(release) antes de realizar la validación');
        let json = log.json;
        // mesajes para validacion de datos
        let data = {},
        // mensajes para validacion de captura
            capture = {};
        let codeList = await _db.manyOrNone('select classificationid from item');

        addError(data,'Identificador OCID', !/.{18}/.test(json.ocid), 'El identificador OCID no cuenta con la longitud esperada. Considerar que el Identificador OCID se construye con el prefijo (ocds-g4facg), guion (-) y el número de registro (PC0001). Por ejemplo: ocds-g4facg-PC0001. Para mayor información, consulte: http://bit.ly/OrientacionEDCA.', json.ocid)

        // validacion de actores       
        if(json.parties){
            data['Actores'] = [];
            capture['Actores'] = [];
            json.parties.map((party, index) => {
                let message = {id: party.id || index};
                addError(message,'Nombre común', party.name && (party.identifier.scheme.toUpperCase()==='MX-INAI' && !(party.name.length >= 3 && party.name.length <= 10)),'En el campo nombre común del registro del área requirente deben indicarse las siglas de la unidad administrativa, no el nombre completo.', party.name ? party.name: '');
                addError(message,'Identificador del actor', party.id && !validateUniqueId(party.id, json.parties), 'Existen varios actores con el mismo identificador', party.id);
                addError(message,'Identificador del actor', party.id &&  party.identifier && party.id !== `${party.identifier.scheme}-${party.identifier.id}`, 'La entrada de datos no corresponde con la estructura solicitada. Utilizar los atributos \'Esquem\' e \'Identificador\' del apartado \'Identificador principal\'', party.id);
                addError(message,'Esquema', party.identifier && isNotNullOrEmpty(party.identifier.scheme) && !/^(MX\-RFC|MX\-INAI|MX\-UNAM)$/.test(party.identifier.scheme.toUpperCase()) , 'La entrada de datos no tiene la longitud esperada según el esquema de identificación definido. Esto puede deberse a que faltan caracteres en el RFC o la CUA', party.identifier ? party.identifier.scheme : '');
                addError(message,'Esquema', !party.identifier|| !isNotNullOrEmpty(party.identifier.scheme), 'Obligatorio');
                addError(message,'Identificador',party.identifier && party.identifier.id && ((party.identifier.scheme && party.identifier.scheme.toUpperCase()==='MX-RFC' && !(party.identifier.id.length >= 12 && party.identifier.id.length <14)) || (party.identifier.scheme && party.identifier.scheme.toUpperCase()==='MX-INAI' && !(party.identifier.id.length === 3 )) || (party.identifier.scheme && party.identifier.scheme.toUpperCase()==='MX-UNAM' && !(party.identifier.id.length === 6)) ),'La entrada de datos no tiene la longitud esperada según el esquema de identificación definido. Esto puede deberse a que faltan caracteres en el RFC, INAI o UNAM', party.identifier ? party.identifier.id: '');
                addError(message,'Código postal', party.address && party.address.postalCode && !/\d{5}/.test(party.address.postalCode), 'La entrada de datos no tiene la longitud esperada para ser un código postal. En México, los códigos postales son de cinco dígitos.', party.address ? party.address.postalCode: '');     
                if(Object.keys(message).length > 1) data['Actores'].push(clean(message));
                
                message = {id: party.id || index};
                addWarning(message,'Nombre común', !isNotNullOrEmpty(party.name), 'Obligatorio');
                addWarning(message,'Identificador del actor', !isNotNullOrEmpty(party.id), 'Obligatorio');
                addWarning(message,'Identificador', !party.identifier || !isNotNullOrEmpty(party.identifier.id), 'Obligatorio');
                addWarning(message,'Nombre o razón social', !party.identifier || !isNotNullOrEmpty(party.identifier.legalName), 'No se ha especificado el nombre o razón social del actor en cuestión.');
                addWarning(message,'Calle y número', !party.address || !isNotNullOrEmpty(party.address.streetAddress), 'No se ha indicado la calle y número del domicilio fiscal del participante. Por ejemplo: Insurgentes sur 3211. En caso de no contar con el dato DEJAR EL CAMPO EN BLANCO. No colocar datos como \'N/A\', \'N/D\' o  \'Sin Dato\'.');            
                addWarning(message,'Delegación o municipio', !party.address || !isNotNullOrEmpty(party.address.locality), 'No se ha señalado la alcaldía o municipio del domicilio fiscal del participante. Por ejemplo: Coyoacán. En caso de no contar con el dato DEJAR EL CAMPO EN BLANCO. No colocar datos como \'N/A\', \'N/D\' o  \'Sin Dato\'.');
                addWarning(message,'Entidad federativa', !party.address || !isNotNullOrEmpty(party.address.region), 'No se ha especificado la entidad federativa del domicilio fiscal del participante. Por ejemplo: Ciudad de México. En caso de no contar con el dato DEJAR EL CAMPO EN BLANCO. No colocar datos como \'N/A\', \'N/D\' o  \'Sin Dato\'.');
                addWarning(message,'País', !party.address || !isNotNullOrEmpty(party.address.countryName), 'No se ha indicado el nombre del país del domicilio fiscal del participante. Por ejemplo: México. En caso de no contar con el dato DEJAR EL CAMPO EN BLANCO. No colocar datos como \'N/A\', \'N/D\' o  \'Sin Dato\'.');
                addWarning(message,'Código postal', !party.address || !party.address.postalCode, 'No se ha capturado el código postal del domicilio fiscal del participante. Por ejemplo 04530. En caso de no contar con el dato DEJAR EL CAMPO EN BLANCO. No colocar datos como \'N/A\', \'N/D\' o  \'Sin Dato\'.');
                addWarning(message,'Nombre del punto de contacto', !party.contactPoint || !isNotNullOrEmpty(party.contactPoint.name), 'No se ha especificado el nombre de la persona de contacto, departamento o punto de contacto en relación a este proceso de contratación. En caso de no contar con el dato DEJAR EL CAMPO EN BLANCO. No colocar datos como \'N/A\', \'N/D\' o  \'Sin Dato\'.');
                addWarning(message,'Correo electrónico', !party.contactPoint || !isNotNullOrEmpty(party.contactPoint.email), 'No se ha señalado la dirección de correo del punto o persona de contacto. En caso de no contar con el dato DEJAR EL CAMPO EN BLANCO. No colocar datos como \'N/A\', \'N/D\' o  \'Sin Dato\'.');
                addWarning(message,'Teléfono', !party.contactPoint || !isNotNullOrEmpty(party.contactPoint.telephone), 'No se ha capturado el número de teléfono del punto o persona de contacto. Este debe de incluir el código de marcación internacional. En caso de no contar con el dato DEJAR EL CAMPO EN BLANCO. No colocar datos como \'N/A\', \'N/D\' o  \'Sin Dato\'.');
                addWarning(message,'Roles', !party.roles, 'Debe tener por lo menos un rol');
                if(Object.keys(message).length > 1) capture['Actores'].push(clean(message));
            });
        } else{
            data['Actores'] = 'No se ha registrado ningún actor';
            errs++;
        }
        
        
        // validacion de planeacion
        let planningData = data['Planeación'] = {},
            planningCapture = capture['Planeación'] = {};

        addError(planningData, 'Justificación', json.planning && json.planning.rationale && json.planning.rationale.length > 900, 'La justificación de la contratación no debe extenderse más allá de 900 caracteres.', json.planning ? json.planning.rationale : '');
        
        addWarning(planningCapture, 'Justificación', !json.planning || !isNotNullOrEmpty(json.planning.rationale), 'No se ha capturado la justificación de la contratación, misma que no debería extenderse más allá de 900 caracteres.');
        
        addDocuments(planningData, planningCapture, json.planning ? json.planning.documents : [], 'planning');
            
        addBudgetbreakdown(planningData, planningCapture, json.planning ? json.planning.budgetbreakdown : [], 'planning');
	        
        // validacion de licitacion
        let dataTender = data['Licitación'] = {},
            captureTender = capture['Licitación'] = {};
            
        addError(dataTender, 'Detalles del método de contratación', json.tender && !validateRelationBetweenProcurementMethodDetailsAndProcurementMethod(json.tender.procurementMethodDetails, json.tender.procurementMethod), 'La selección del método de contratación no coincide con el tipo de procedimiento elegido en \'Detalles del método de contratación\'. Para más información, consultar la tabla de equivalencias en la presentación: http://bit.ly/OrientacionEDCA.', json.tender ? json.tender.procurementMethodDetails : '');
        addError(dataTender, 'Categoría principal de la contratación', json.tender && json.tender.additionalProcurementCategories && !validateRelationBetweenAdditionalProcurementCategoriesAndMainProcurementCategory(json.tender.additionalProcurementCategories[0],json.tender.mainProcurementCategory), 'La categoría principal de la contratación especificada no coincide con la categoría adicional especificada.' ,json.tender ? json.tender.additionalProcurementCategories : []);
        addError(dataTender, 'Número de licitantes', json.tender && json.parties && (json.tender.numberOfTenderers !== json.parties.filter(p =>  p.roles && p.roles.indexOf('tenderer') !== - 1).length), 'La cantidad de licitantes especificada no coincide con los registros en la sección \'Actores involucrados\'. Considerar que en adjudicación directa los licitantes serán aquellos que presentaron una oferta.', json.tender ? json.tender.numberOfTenderers : 0);   

        addWarning(captureTender, 'Identificador de la licitación', !json.tender || !isNotNullOrEmpty(json.tender.id), 'Obligatorio');
        addWarning(captureTender, 'Denominación de la licitación', !json.tender || !isNotNullOrEmpty(json.tender.title), 'Obligatoria');
        addWarning(captureTender, 'Objeto de la licitación', !json.tender || !isNotNullOrEmpty(json.tender.id), 'Obligatorio');
        addWarning(captureTender, 'Estatus de la licitación', !json.tender || !isNotNullOrEmpty(json.tender.status), 'Obligatorio');
        addWarning(captureTender, 'Monto de Valor', !json.tender || !json.tender.value || !json.tender.value.amount, 'Obligatorio');
        addWarning(captureTender, 'Moneda', !json.tender || !json.tender.value || !isNotNullOrEmpty(json.tender.value.currency), 'Obligatoria');
        addWarning(captureTender, 'Método de contratación', !json.tender || !isNotNullOrEmpty(json.tender.procurementMethod), 'Obligatorio');
        addWarning(captureTender, 'Detalles del método de contratación', !json.tender || !isNotNullOrEmpty(json.tender.procurementMethodDetails), 'Obligatorios');
        addWarning(captureTender, 'Justificación del método de contratación', !json.tender || !isNotNullOrEmpty(json.tender.procurementMethodRationale), 'No se ha especificado la justificación del método de contratación.');
        addWarning(captureTender, 'Categoría principal de la contratación', !json.tender || !isNotNullOrEmpty(json.tender.mainProcurementCategory), 'Obligatoria');
        addWarning(captureTender, 'Categorías adicionales de contratación', !json.tender || !json.tender.additionalProcurementCategories, 'Obligatorias');
        addWarning(captureTender, 'Criterio de evaluación de proposiciones', !json.tender || !isNotNullOrEmpty(json.tender.awardCriteria), 'No se han especificado los criterios de evaluación de proposiciones para el procedimiento de contratación. Este dato podría encontrarse en la Convocatoria.');
        addWarning(captureTender, 'Detalles sobre el criterio de evaluación de proposiciones', !json.tender || !isNotNullOrEmpty(json.tender.awardCriteriaDetails), 'No se ha señalado la descripción del mecanismo de evaluación de proposiciones a utilizar en el procedimiento de contratación.');
        addWarning(captureTender, 'Medios para la recepción de las proposiciones', !json.tender || !json.tender.submissionMethod, 'Obligatorios');
        addWarning(captureTender, 'Descripción de los medios para la recepción de las proposiciones', !json.tender || !isNotNullOrEmpty(json.tender.submissionMethodDetails), 'No se ha especificado el método por el cual las proposiciones deben de ser enviadas. Por ejemplo: electrónica, presencial, mixto o subasta electrónica.');
        addWarning(captureTender, 'Fecha de inicio de Período de entrega de proposiciones', !json.tender || !json.tender.tenderPeriod || !json.tender.tenderPeriod.startDate, 'No se ha indicado la fecha de inicio del periodo de entrega de proposiciones.');
        addWarning(captureTender, 'Fecha de fin de Período de entrega de proposiciones', !json.tender || !json.tender.tenderPeriod || !json.tender.tenderPeriod.endDate, 'No se ha indicado la fecha de fin del periodo de entrega de proposiciones.');
        addWarning(captureTender, 'Fecha de inicio de Período para presentar solicitudes de aclaración', !json.tender || !json.tender.enquiryPeriod || !json.tender.enquiryPeriod.startDate, 'No se ha indicado la fecha de inicio del periodo para presentar solicitudes de aclaración.');
        addWarning(captureTender, 'Fecha de fin de Período para presentar solicitudes de aclaración', !json.tender || !json.tender.enquiryPeriod || !json.tender.enquiryPeriod.endDate, 'No se ha indicado la fecha de fin del periodo para presentar solicitudes de aclaración.');
        addWarning(captureTender, '¿Hubo solicitudes de aclaración?', !json.tender || json.tender.hasEnquiries === undefined, 'Obligatorio');
        addWarning(captureTender, 'Criterios de elegibilidad', !json.tender || !isNotNullOrEmpty(json.tender.eligibilityCriteria), 'No se han indicado los requisitos y condiciones que deben cumplir los interesados para participar en el procedimiento de contratación. ');
        addWarning(captureTender, 'Fecha de inicio de Período de evaluación y adjudicación', !json.tender || !json.tender.awardPeriod || !json.tender.awardPeriod.startDate, 'No se ha indicado la fecha de incio del periodo de evaluación y adjudicación.');
        addWarning(captureTender, 'Fecha de fin de Período de evaluación y adjudicación', !json.tender || !json.tender.awardPeriod || !json.tender.awardPeriod.endDate, 'No se ha indicado la fecha de fin del periodo de evaluación y adjudicación.');
        addWarning(captureTender, 'Número de licitantes', !json.tender || !json.tender.numberOfTenderers, 'Obligatorio');
        
        addAmendment(dataTender, captureTender, json.tender ? json.tender.amendments : []);
        addDocuments(dataTender, captureTender, json.tender ? json.tender.documents: [], 'tender');
        addItems(dataTender, captureTender, json.tender ? json.tender.items: [], codeList);

        // validacion de adjudicacion
        if(json.awards){
            let dataAwards = data['Adjudicaciones'] = [];
            let captureAwards = capture['Adjudicaciones'] = [];
            json.awards.map((award, index) => {
                let messageData = {id: award.id || index};
                let messageCapture = {id: award.id || index};

                // ignorar si todo esta vacio
                if(Object.keys(award).length === 0){
                    return;
                }

                addError(messageData,'Identificador del la adjudicación', award.id && !validateUniqueId(award.id, json.awards), 'Existen varias adjudicaciones con el mismo identificador', award.id);
                addError(messageData, 'Monto sin impuestos', !award.value || award.value.netAmount <= 0 , 'El monto especificado no puede ser cero.', award.value ? award.value.netAmount : '');
                
                addWarning(messageCapture, 'Identificador de la adjudicación', !isNotNullOrEmpty(award.id), 'Obligatorio');
                addWarning(messageCapture, 'Título', !isNotNullOrEmpty(award.title), 'No se ha capturado el título de la adjudicación.');
                addWarning(messageCapture, 'Descripción',!isNotNullOrEmpty(award.description), 'No se ha capturado la descripción de la adjudicación.');
                addWarning(messageCapture, 'Estatus de adjudicación', !isNotNullOrEmpty(award.status), 'No se ha indicado el estatus de la adjudicación.');
                addWarning(messageCapture, 'Fecha de la adjudicación', !award.date, 'No se ha señalado la fecha en que se realizó la adjudicación o fallo.');
                addWarning(messageCapture, 'Monto', !award.value || !award.value.amount , 'Obligatorio');
                addWarning(messageCapture, 'Moneda', !award.value || !isNotNullOrEmpty(award.value.currency) , 'Obligatoria');
                addWarning(messageCapture, 'Proveedores', !award.suppliers, 'No ha seleccionado ningún proveedor');
                addWarning(messageCapture, 'Fecha de inicio', !award.contractPeriod || !award.contractPeriod.startDate, 'No se ha señalado la fecha de inicio del contrato.');
                addWarning(messageCapture, 'Fecha de fin', !award.contractPeriod || !award.contractPeriod.endDate, 'No se ha señalado la fecha de fin del contrato.');
                addWarning(messageCapture, 'Monto', !award.value || award.value.netAmount > award.value.amount, 'El monto sin impuestos no puede ser mayor al monto total');
             
                addAmendment(messageData,messageCapture, award.amendments);
                addDocuments(messageData,messageCapture, award.documents, 'award');

                if(Object.keys(messageData).length > 1) dataAwards.push(messageData);
                if(Object.keys(messageCapture).length > 1) captureAwards.push(messageCapture);
            });
        } else{
            capture['Adjudicaciones'] = 'No se ha registrado ningúna adjudicación';
        }

        // validacion de contratos
        if(json.contracts) {
            let dataContracts = data['Contratos'] = [],
                captureContracts = capture['Contratos'] = [];
            json.contracts.map((contract, index) => {
                let messageData = {id: contract.id || index};
                let messageCapture = {id: contract.id || index};


                 // ignorar si todo esta vacio
                 if(Object.keys(contract).length === 0){
                     return;
                 }

                addError(messageData,'Identificador del contrato', contract.id && !validateUniqueId(contract.id, json.contracts), 'Existen varios contratos con el mismo identificador', contract.id);
                addError(messageData, 'Monto sin impuestos', contract.value && contract.value.netAmount <= 0, 'El monto especificado no puede ser cero.', contract.value ? contract.value.netAmount : '');
                
                addWarning(messageCapture, 'Identificador del contrato', !isNotNullOrEmpty(contract.id), 'Obligatorio');
                addWarning(messageCapture, 'Identificador de la adjudicación', !isNotNullOrEmpty(contract.awardID), 'Obligatorio');
                addWarning(messageCapture, 'Título del contrato', !isNotNullOrEmpty(contract.title), 'No se ha especificado el título del contrato.');
                addWarning(messageCapture, 'Objeto del contrato', !isNotNullOrEmpty(contract.description), 'No se ha especificado el objeto del contrato.');
                addWarning(messageCapture, 'Estatus del contrato', !isNotNullOrEmpty(contract.status), 'No se ha indicado el estatus del contrato.');
                addWarning(messageCapture, 'Fecha de inicio', !contract.period || !contract.period.startDate, 'No se ha señalado la fecha de inicio de la vigencia del contrato.');
                addWarning(messageCapture, 'Fecha de fin', !contract.period || !contract.period.endDate, 'No se ha señalado la fecha de fin de la vigencia del contrato.');
                addWarning(messageCapture, 'Monto sin impuestos', !contract.value || !contract.value.netAmount, 'Obligatorio');
                addWarning(messageCapture, 'Monto total', !contract.value || !contract.value.amount, 'Obligatorio');
                addWarning(messageCapture, 'Moneda', !contract.value || !isNotNullOrEmpty(contract.value.currency), 'Obligatoria');
                addWarning(messageCapture, 'Fecha de firma del contrato', !contract.dateSigned, 'No se ha especificado la fecha en que se firmó el contrato.');
                addWarning(messageCapture, 'Monto', !contract.value || contract.value.netAmount > contract.value.amount,'El monto sin impuestos no puede ser mayor que el monto total');

                addAmendment(messageData, messageCapture, contract.amendments);
                addDocuments(messageData, messageCapture, contract.documents, 'contract');
                addItems(messageData, messageCapture, contract.items, codeList);

           // validacion de implementacion
                if(contract.implementation) {
                    let dataImplementation = messageData['Implementación'] = {};
                    let captureImplementation = messageCapture['Implementación'] = {};
                    addWarning(captureImplementation, 'Estatus de la implementación', !contract.implementation.status, 'No se ha indicado el estatus de la implementación.');
                    addDocuments(dataImplementation,captureImplementation , contract.implementation.documents, 'implementation');
                    addTransactions(dataImplementation, captureImplementation, contract.implementation.transactions);
                } 
				//else {
                //    messageData['Implementación'] = 'No se ha especificado la implementación' 
                //    errs++;
                //}
                messageData = clean(messageData);
                messageCapture = clean(messageCapture);
                if(Object.keys(messageData).length > 1) dataContracts.push(messageData);
                if(Object.keys(messageCapture).length > 1) captureContracts.push(messageCapture);
            });
        } else {
            capture['Contratos'] = 'No se ha especificado ningún contrato';
        }
             
        data = clean(data);
        capture = clean(capture);

        return clean({
            valid: errs === 0,
            data: data,
            capture: capture,
            resume: generateResume(cpid, json)
        });
    }

    
    let addWarning = (obj, propety, error, message) => {
        if(error) {
            obj[propety] = message;
            warns++;
        } 
    }

    let addError = (obj, propety, error, message, value) => {
        if(error) {
            obj[propety] = {
                mensaje: message,
                valor: value
            };
            errs++;
        } 
    }

    let addAmendment = (obj, amendments) => {
        if(Array.isArray(amendments) && amendments){
            let mods = [];
            amendments.map((am, index) => {
                let message = {id: am.id || index};
                addWarning(message, 'Descripción', !isNotNullOrEmpty(am.description), 'Obligatoria');
                addWarning(message, 'Justificación', !isNotNullOrEmpty(am.rationale), 'Obligatoria');
                if(Object.keys(message).length > 1) mods.push(message);
            });
            if(mods.length > 0) obj['Modificaciones'] = mods;
        }
    }

    let addDocuments = (data, capture, documents, stage) => {
        if(Array.isArray(documents) && documents){
            let docsData = [], docCapture = [];
            documents.map((doc, index) => {
                let message = {id: doc.id || index};
                addError(message,'Identificador', doc.id && !validateUniqueId(doc.id, documents), 'Existen varios documentos con el mismo identificador');
                addError(message, 'Tipo de documento', doc.documentType && validateTypeOfDocument(doc.documentType, stage), 'Obligatorio', doc.documentType);
                addError(message, 'Formato', doc.format && !/PDF|XLSX|DOCX|DOC|PNG|JPEG|JPG|XLS|CSV/.test(doc.format.toUpperCase()), 'La entrada de datos no coincide con un formato reconocido. En el caso de documentos \'.pdf\' especificar PDF.', doc.format);
                if(Object.keys(message).length > 1) docsData.push(message);
                message = {id: doc.id || index};

                addWarning(message, 'Identificador', !isNotNullOrEmpty(doc.id), 'Obligatorio');
                addWarning(message, 'Tipo de documento', !isNotNullOrEmpty(doc.documentType), 'Obligatorio');
                addWarning(message, 'Título', !isNotNullOrEmpty(doc.title), 'Obligatorio');
                addWarning(message, 'URL', !isNotNullOrEmpty(doc.url), 'Obligatorio');
                addWarning(message, 'Fecha de publicación', !doc.datePublished, 'No se ha especificado la fecha de publicación del documento.');
                addWarning(message, 'Formato', !isNotNullOrEmpty(doc.format), 'No se ha especificado el formato del documento. Por ejemplo \'PDF\'.');

                if(Object.keys(message).length > 1) docCapture.push(message);
            });
            if(docsData.length > 0) data['Documentos'] = docsData;
            if(docCapture.length > 0) capture['Documentos'] = docCapture;
        }
    }

    let addItems = (data, capture, items, codeList) => {
        if(Array.isArray(items) && items){
            let iemsData = [], iemCapture = [];            
            items.map((iem, index) => {          	
                let message = {id: iem.id || index};
                addError(message, 'Identificador', iem.id && !validateUniqueId(iem.id, items), 'Existen varios items con el mismo identificador', iem.id);
                addError(message, 'Nombre de la unidad de medida', iem.unit && iem.unit.name && codeList.filter(x => x.classificationid === iem.unit.name) === -1, 'El nombre de la unidad de medida no coincide con la clave CUCOP introducida. Para mayor información, utilizar la herramienta de apoyo para obtener los valores de la clave CUCOP en http://bit.ly/ApoyoEDCA.', iem.unit ? iem.unit.name : '');
              //addError(message, 'Identificador de Clasificación', iem.classification && iem.classification.id && iem.classification.id.length !== 8, 'La entrada de datos no tiene la longitud esperada según el esquema de identificación CUCOP. La clave CUCOP consta de ocho caracteres.',  iem.classification ? iem.classification.id : '');
                addError(message, 'Esquema', iem.classification && iem.classification.scheme !== 'CUCOP' && iem.classification.scheme !== 'COG', 'El esquema de identificación seleccionado no es el correcto. Utilizar la opción \'CUCOP\' o \'COG\'.', iem.classification ? iem.classification.scheme : '');                  
                if(Object.keys(message).length > 1) iemsData.push(message);
              
                message = {id: iem.id || index};
                addWarning(message, 'Ubicación', !isNotNullOrEmpty(iem.deliveryAddress), 'No se ha especificado la ubicación donde se entregará el bien o donde se realizará el servicio u obra pública.');
                
                if(Object.keys(message).length > 1) iemCapture.push(message);                
            });         
            if(iemsData.length > 0)  data['Items'] = iemsData;
            if(iemCapture.length > 0)  capture['Items'] = iemCapture;
        }
        else{
        	let message = {id: 'No se ha registrado ningún ítem. Considerar que los ítems deben registrarse en la etapa de Licitación y Contrato.'};
        	capture['Items'] = [message];          
        }
    }
    
    let addBudgetbreakdown = (data, capture, budgetbreakdown) => {
        if(Array.isArray(budgetbreakdown) && budgetbreakdown){
            let bdgData = [], bdgCapture = [];            
            budgetbreakdown.map((bdg, index) => {          	
            	let message = {id: bdg.id || index};
                addWarning(message, 'Descripción', !isNotNullOrEmpty(bdg.description), 'No hay descripción');
                addWarning(message, 'Id', bdg.budgetbreakdown_id == null, 'No hay id');
                
                if(Object.keys(message).length > 1) bdgCapture.push(message); 
                console.log ("entro al if")
            });
            if(bdgCapture.length > 0)  capture['Desglose del presupuesto'] = bdgCapture;
        }
     //   else{
     //   	let message = {Identificador: 'No se ha registrado información en el formulario \'Clasificación del presupuesto\'.'};
     //   	data['Desglose del presupuesto'] = [message];
     //   	console.log ("entro al else")
     //   }
    }
    
    let addTransactions = (data, capture, transactions) => {
        if(Array.isArray(transactions) && transactions) {
            let transData = [], transCapture = [];
            transactions.map((t, index) => {
                let message = {id: t.id || index};
                addError(message, 'Monto total', t.value && t.netAmount && parseFloat(t.value.netAmount) > t.amount, 'Monto total debe ser mayor o igual a monto sin impuestos',t.value ? t.amount : '');
                if(Object.keys(message).length > 1) transData.push(message);

                message = {id: t.id || index};
                addWarning(message, 'Emisor', !t.payer, 'No se ha seleccionado el Emisor');
                addWarning(message, 'Receptor', !t.payee, 'No se ha seleccionado el Receptor');
                if(Object.keys(message).length > 1) transCapture.push(message);
            });
            if(transData.length > 0) data['Transacciones'] = transData;
            if(transCapture.length > 0) capture['Transacciones'] = transCapture;
        }
    }    
    
    let generateResume = function(cpid, json){
        let buyer =  json.parties ? json.parties.filter(p => p.roles && p.roles.indexOf('buyer') !== -1)[0]: undefined;
        let requestingUnit = json.parties ? json.parties.filter(p => p.roles && p.roles.indexOf('requestingUnit') !== -1)[0]: undefined;
        let empty = 'Sin dato';
        let amount = 0;
        let amount2 = 0;

        if(json.contracts){
            // calculo del saldo
            json.contracts.map(x => amount += x.value ? x.value.amount || 0 : 0);
            json.contracts.map(x =>  x.implementation && x.implementation.transactions ? x.implementation.transactions.map(t => {
                amount -= t.value ? t.value.amount || 0 : 0;
            }) : 0);
            // calculo del pago
            json.contracts.map(x =>  x.implementation && x.implementation.transactions ? x.implementation.transactions.map(t => {
                amount2 += t.value ? t.value.amount || 0 : 0;
            }) : 0);
        }

        let resume = {
            registry: cpid,
            unitAdministrative: requestingUnit ? requestingUnit.name || empty : empty,
            identifier: requestingUnit ? requestingUnit.id || empty : empty,
            date: json.date,
            name: json.tender ? json.tender.title || empty : empty,
            type: json.tender ? json.tender.procurementMethodDetails || empty : empty,
            element: json.tender ? getSpanishMainProcurementCategory(json.tender.mainProcurementCategory) || empty : empty,
            missing: warns,
            errors: errs,
            total: countLength(json),
            status: getEtapaCaptura(json),
            stagesStatus:{
                tender: getValueStatus(TypesOfStatus.licitacion, json.tender.status),
                award:  json.awards ? json.awards.map(x => getValueStatus(TypesOfStatus.adjudicacion, x.status)).join(', '): empty,
                contract: json.contracts ? json.contracts.map(x => getValueStatus(TypesOfStatus.contratacion, x.status)).join(', ') : empty,
                implementation: json.contracts ? json.contracts.map(x => {
                    let value = getValueStatus(TypesOfStatus.ejecucion, x.implementation ? x.implementation.status : empty);
                    if(value) return value;
                }).join(', ') || empty : empty,
            },
            documents: {
                // Justificación de la contratación
                needsAssessment: getDocMessage('needsAssessment', json.planning && json.planning.documents ? json.planning.documents.findIndex(x => x.documentType === 'needsAssessment') !== -1 : false, json.tender.procurementMethodDetails),
                // Anexo técnico
                technicalSpecifications: getDocMessage('technicalSpecifications', json.tender && json.tender.documents ? json.tender.documents.findIndex(x => x.documentType === 'technicalSpecifications') !== -1 : false, json.tender.procurementMethodDetails),
                // Convocatoria
                tenderNotice: getDocMessage('tenderNotice', json.tender && json.tender.documents ? json.tender.documents.findIndex(x => x.documentType === 'tenderNotice') !== -1 : false, json.tender.procurementMethodDetails),
                // juntas de aclaraciones
                clarifications: getDocMessage('clarifications', json.tender && json.tender.documents ? json.tender.documents.findIndex(x => x.documentType === 'clarifications') !== -1 : false, json.tender.procurementMethodDetails),
                // estudio de mercado
                marketStudies: getDocMessage('marketStudies', json.planning && json.planning.documents ? json.planning.documents.findIndex(x => x.documentType === 'marketStudies') !== -1 : false, json.tender.procurementMethodDetails),
                // Plan de proyecto
                projectPlan:  getDocMessage('projectPlan', json.planning  && json.planning.documents? json.planning.documents.findIndex(x => x.documentType === 'projectPlan') !== -1 : false, json.tender.procurementMethodDetails),
                // Fallo o notificación
                awardNotice:  getDocMessage('awardNotice', json.awards ? json.awards.findIndex(y => y.documents ? y.documents.find(x => x.documentType === 'awardNotice') : false) !== -1 : false, json.tender.procurementMethodDetails) ,
                // Contrato firmado
                contractSigned: getDocMessage('contractSigned', json.contracts ? json.contracts.findIndex(y => y.documents ? y.documents.find(x => x.documentType === 'contractSigned') : false) !== -1 : false, json.tender.procurementMethodDetails) ,
                // Documento en el que conste la conclusión de la contratación
                completionCertificate: getDocMessage('completionCertificate', json.contracts ? json.contracts.findIndex(y => y.implementation && y.implementation.documents ? y.implementation.documents.find(x => x.documentType === 'completionCertificate') : false) !== -1 : false, json.tender.procurementMethodDetails),
            },
            parties: {
                buyer: buyer !== undefined ? 'Registrado' : 'No registrado',
                requestingUnit: requestingUnit !== undefined ? 'Registrado' : 'No registrado',
                procuringEntity: json.parties && json.parties.filter(p => p.roles && p.roles.indexOf('procuringEntity') !== -1).length > 0 ? 'Registrado' : 'No registrado',
                supplier: json.parties && json.parties.filter(p => p.roles &&  p.roles.indexOf('supplier') !== -1).length > 0 ? 'Registrado' : 'No registrado',
                payer: json.parties && json.parties.filter(p => p.roles &&  p.roles.indexOf('payer') !== -1).length > 0 ? 'Registrado' : 'No registrado',
                payee: json.parties && json.parties.filter(p => p.roles &&  p.roles.indexOf('payee') !== -1).length > 0 ? 'Registrado' : 'No registrado',
                tenderer: json.parties && json.parties.filter(p => p.roles &&  p.roles.indexOf('tenderer') !== -1).length > 0 ? 'Registrado' : 'No registrado'
            },
            items: {
                tender: (json.tender && json.tender.items ?  json.tender.items.length > 0 : false)  ? 'Registrado' : 'No registrado',
                contracts: json.contracts ? json.contracts.map(x => x.items && x.items.length > 0 ? 'Registrado' : 'No registrado') : ['No registrado'] ,
            },
            transactions: json.contracts ? json.contracts.map(x => (x.implementation && x.implementation.transactions 
            		? x.implementation.transactions.length > 0 : false) ? 'Registrado' : 'No registrado' ) : ['No registrado'],
            	amount: amount,
            	pago_amount: amount2
        };
        return resume;
    }

    let getDocMessage = (type, valid, method) => {
        let msPublished = 'El documento se encuentra público.',
            msNotPublished = 'El documento aún no se ha publicado.',
            msNotApply = 'No es necesaria la publicación de este documento';

        switch(type){
            case 'technicalSpecifications':
                switch(method){
                    case 'Adjudicación directa art.42':
                    case 'Adjudicación directa art.41':
                        return valid ? msPublished : msNotPublished;
                    case 'Licitación pública':
                    case 'Excepciones al reglamento':
                    case 'Invitación a cuando menos tres personas':
                    case 'Convenio de colaboración':
                    case 'Adhesiones y membresías':
                        return msNotApply;;
                }
                break;
            case 'clarifications':
            case 'tenderNotice':
                    switch(method){
                        case 'Licitación pública':
                        case 'Invitación a cuando menos tres personas':
                            return valid ? msPublished : msNotPublished;
                        default:
                            return msNotApply;;
                    }
            case 'marketStudies':
            case 'projectPlan':
            case 'awardNotice':
            case 'needsAssessment':
                switch(method){
                    case 'Licitación pública':
                    case 'Adjudicación directa art.42':
                    case 'Adjudicación directa art.41':
                    case 'Invitación a cuando menos tres personas':
                        return valid ? msPublished : msNotPublished;
                    default:
                        return msNotApply;
                }
            case 'contractSigned':
            case 'completionCertificate':
                switch(method){
                    case 'Licitación pública':
                    case 'Adjudicación directa art.42':
                    case 'Adjudicación directa art.41':
                    case 'Excepciones al reglamento':
                    case 'Invitación a cuando menos tres personas':
                    case 'Convenio de colaboración':
                    case 'Adhesiones y membresías':
                        return valid ? msPublished : msNotPublished;
                }
        }
        return  msNotPublished;
    }

    let getEtapaCaptura = json => {
        if(json.contracts !== undefined && json.awards !== undefined){
            if(json.contracts.find(x => x.implementation && x.implementation.status)) {
                return 'Implementación'
            } else if(json.contracts.find(x => x.status)) {
                return 'Contrato'
            } else if(json.awards.find(x => x.status)){
                return 'Adjudicación'
            } else if(json.tender.status) {
                return 'Licitación'
            } else{
                return 'Planeación'
            }
        }else{
            return 'Planeación'
        }
        
    }

    let countLength = json => {
        let total = 0;
        if(json === undefined || json === null) return total;
        if(Array.isArray(json)){
            json.map(x => total += countLength(x));
        } else if(typeof json === 'object'){
            Object.keys(json).map(key => total += countLength(json[key]));
        } else {
            return 1;
        }
        
        return total;
    }


    /**
     * Limpiar propiedades vacias
     * @param {Object} obj Objeto a limpiar de propiedades vacias
     */
    let clean = obj => {
        if(!obj || obj === null) return {};
        Object.keys(obj).map(key => {
            if(obj[key] === undefined ||
                obj[key] === null ||
                (Array.isArray(obj[key]) && obj[key].length === 0) || 
                (typeof obj[key] === 'object' && !(obj[key] instanceof Date) && Object.keys(obj[key]).length === 0) ||
                (typeof obj[key] === 'string' && obj[key].trim() === '') ||
                (typeof obj[key] === 'number' && isNaN(obj[key]))){
                 delete obj[key];
             }
        });
        return obj;
    }
}

module.exports = ValidateProcess;