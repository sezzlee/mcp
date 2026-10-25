using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

var failed = false;
foreach (var file in args)
{
    using var package = SpreadsheetDocument.Open(file, false);
    var validator = new OpenXmlValidator(FileFormatVersions.Office2019);
    var errors = validator.Validate(package).ToArray();
    failed |= errors.Length != 0;
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        file,
        errors = errors.Length,
        details = errors.Take(20).Select(error => new
        {
            error.Id,
            error.Description,
            part = error.Part?.Uri.ToString(),
            path = error.Path?.XPath,
        }),
    }));
}
Environment.ExitCode = failed ? 1 : 0;
