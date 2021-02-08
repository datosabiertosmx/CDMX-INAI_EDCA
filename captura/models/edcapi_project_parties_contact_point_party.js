'use strict';
module.exports = (sequelize, DataTypes) => {
  const edcapi_project_parties_contact_point_party = sequelize.define('edcapi_project_parties_contact_point_party', {
    edcapiProjectPartiesContactPointId: DataTypes.INTEGER,
    party_id: DataTypes.INTEGER
  }, {});
  edcapi_project_parties_contact_point_party.associate = function(models) {
    // associations can be defined here
  };
  return edcapi_project_parties_contact_point_party;
};