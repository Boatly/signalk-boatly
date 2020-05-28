export module Util {
    export function radsToDeg(radians: number): number {
        // Round to integer
        return Math.round(radians * 180 / Math.PI)
    }

    export function mpsToKn(mps: number): number {
        // Round to 1 dp
        return Math.round(1.9438444924574 * mps * 10) / 10
    }

    export function degreesToRadians(degrees: number): number {
        return degrees * Math.PI / 180;
    }

    // Return meters between two lat, lon coordinates
    export function distanceBetweenCoordinates(lat1: number, lon1: number, lat2: number, lon2: number) {
        var earthRadius = 6371000; // meters

        var dLat = degreesToRadians(lat2 - lat1);
        var dLon = degreesToRadians(lon2 - lon1);

        lat1 = degreesToRadians(lat1);
        lat2 = degreesToRadians(lat2);

        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return earthRadius * c;
    }

}
