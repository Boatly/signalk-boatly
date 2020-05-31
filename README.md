# Boatly SignalK Plugin

A SignalK plugin that logs sailing passages and uploads them to **Boatly**.

[Boatly](https://www.boatly.com) is a free web application that enables you to upload and share your sailing passages:

https://www.boatly.com

Recording automatically starts when the vessel moves a defined number of meters from the vessel's initial position.   Recording stops, and the end of the passage is determined, when the vessel has been stationary for a defined number of minutes.

The following data is logged:
- Position (`navigation.position`)
- Course over ground (`navigation.courseOverGroundTrue`)
- Speed over ground (`navigation.speedOverGround`)
- True wind speed (`environment.wind.speedOverGround`)
- True wind angle (`environment.wind.angleTrueGround`)
- True wind direction (`environment.wind.directionTrue`)

Position reports with a horizontal dillution of position (hdop) > 5 are ignored.

Position reports are logged to a SQLite database.  The location of that database is displayed within the web app, if you need to access it directly.

The web app also enables you to download the GPX file for each passage.  This is mainly provided for debugging purposes as the GPX file is uploaded to boatly automatically when the upload process is initiated.
