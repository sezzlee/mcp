const text = (value: string) => ({ kind: "text", value });
const number = (value: number) => ({ kind: "number", value });
const blank = { kind: "blank" };
const sales = [
  { kind: "add_sheet", name: "Sales" },
  {
    kind: "write_cells",
    sheetName: "Sales",
    startCell: "A1",
    values: [
      [text("Item"), text("Qty"), text("Price"), text("Amount")],
      [text("A"), number(2), number(10), blank],
      [text("B"), number(3), number(5), blank],
    ],
  },
  {
    kind: "create_table",
    sheetName: "Sales",
    range: "A1:D4",
    name: "SalesData",
    calculatedColumns: [{ column: "Amount", formula: "[@Qty]*[@Price]" }],
    totals: [
      { kind: "label", column: "Item", text: "Total" },
      { kind: "function", column: "Amount", function: "sum" },
    ],
  },
  {
    kind: "write_formula",
    sheetName: "Sales",
    cell: "F1",
    formula: "SUM(SalesData[Amount])",
  },
];
export const authoringScenarios = {
  authoring_format: {
    tr: "Kaynağı ve mevcut sayfaları koruyarak yeni bir Expenses sayfası ekle. Başlıklar Date, Item, Amount, Rate olsun. İki kayıt: 2026-01-02, Office, 20, 0.18 ve 2026-01-03, Travel, 50, 0.08. Tarihleri gerçek tarih, tutar/oranları sayı yaz. Tarihler yıl-ay-gün, Amount iki ondalıklı TRY, Rate yüzde görünsün; alttaki sayılar değişmesin. Başlık koyu mavi zemin üzerinde beyaz kalın ve kaydırmalı metin olsun. Dört kolonun genişliğini 22 yap, ilk satırı sabitle, A1:D3 alanını yatay ve tek sayfa genişliğinde yazdırılacak şekilde ayarla. Tek tamamlanmış Excel çıktısı üret.",
    en: "Preserve the source and existing sheets; add Expenses with headers Date, Item, Amount, Rate. Records: 2026-01-02, Office, 20, 0.18 and 2026-01-03, Travel, 50, 0.08. Write actual dates and numeric amounts/rates. Show year-month-day dates, two-decimal TRY amounts and percentages without changing stored numbers. Use bold white wrapped headers on dark blue. Set all four column widths to 22, freeze row 1 and print A1:D3 landscape, one page wide. Produce one finished Excel output.",
    changes: [
      { kind: "add_sheet", name: "Expenses" },
      {
        kind: "write_cells",
        sheetName: "Expenses",
        startCell: "A1",
        values: [
          [text("Date"), text("Item"), text("Amount"), text("Rate")],
          [
            { kind: "date", value: "2026-01-02" },
            text("Office"),
            number(20),
            number(0.18),
          ],
          [
            { kind: "date", value: "2026-01-03" },
            text("Travel"),
            number(50),
            number(0.08),
          ],
        ],
      },
      {
        kind: "format_cells",
        sheetName: "Expenses",
        range: "A2:A3",
        style: { numberFormat: "yyyy-mm-dd" },
      },
      {
        kind: "format_cells",
        sheetName: "Expenses",
        range: "C2:C3",
        style: { numberFormat: '#,##0.00 "TRY"' },
      },
      {
        kind: "format_cells",
        sheetName: "Expenses",
        range: "D2:D3",
        style: { numberFormat: "0.00%" },
      },
      {
        kind: "format_cells",
        sheetName: "Expenses",
        range: "A1:D1",
        style: {
          font: { bold: true, color: "FFFFFF" },
          fill: "1F4E78",
          alignment: { wrapText: true },
        },
      },
      {
        kind: "set_columns",
        sheetName: "Expenses",
        first: 1,
        last: 4,
        width: 22,
      },
      { kind: "freeze_panes", sheetName: "Expenses", rows: 1, columns: 0 },
      {
        kind: "set_print_layout",
        sheetName: "Expenses",
        orientation: "landscape",
        fitWidth: 1,
        fitHeight: 0,
        printArea: "A1:D3",
      },
    ],
  },
  authoring_formula: {
    tr: "Mevcut sayfaları koruyarak Calc sayfasına Qty, Price, Gross başlıklarıyla iki satır ekle: 2 adet 10 ve 3 adet 5. F1 hücresine vergi oranını sayı olarak 0.18 yaz. Gross kolonuna miktar × fiyat × (1 + vergi) formülünü iki satır için doldur; vergi başvurusu sabit kalsın. Calc!E1 hücresine =1+1 ifadesini literal metin yaz. Yeni Summary sayfasında A1, Calc sayfasının Gross kolonundaki iki satırın toplam formülü olsun. Formülleri gerçek formül olarak yaz; sunucuda hesaplandığını söyleme ve sonuç uydurma.",
    en: "Preserve existing sheets. Add Calc with Qty, Price, Gross headers and two rows: quantity 2 at price 10, and quantity 3 at price 5. Put numeric tax rate 0.18 in F1. Fill Gross with quantity × price × (1 + tax), keeping the tax reference absolute. Calc!E1 must contain literal text =1+1. Add Summary with A1 containing a formula summing the two Gross rows on Calc. Write real formulas without inventing cached results or claiming server calculation.",
    changes: [
      { kind: "add_sheet", name: "Calc" },
      { kind: "add_sheet", name: "Summary" },
      {
        kind: "write_cells",
        sheetName: "Calc",
        startCell: "A1",
        values: [
          [text("Qty"), text("Price"), text("Gross")],
          [number(2), number(10), blank],
          [number(3), number(5), blank],
        ],
      },
      {
        kind: "write_cells",
        sheetName: "Calc",
        startCell: "E1",
        values: [[text("=1+1"), number(0.18)]],
      },
      {
        kind: "fill_formula",
        sheetName: "Calc",
        anchor: "C2",
        range: "C2:C3",
        formula: "A2*B2*(1+$F$1)",
      },
      {
        kind: "write_formula",
        sheetName: "Summary",
        cell: "A1",
        formula: "SUM(Calc!C2:C3)",
      },
    ],
  },
  authoring_table: {
    tr: "Mevcut sayfaları koru. Yeni Sales sayfasında Item, Qty, Price, Amount kolonlarıyla SalesData adlı gerçek Excel tablosu oluştur. İlk kayıtlar A,2,10 ve B,3,5 olsun; Amount miktar × fiyat formülüyle hesaplansın. Total etiketli toplam satırında Amount için toplam formülü olsun. Sales!F1, kolon adına bağlı SUM(SalesData[Amount]) formülü olsun. Sonra C,4,2 kaydını tabloya ekle; Amount formülünü ve toplam satırını koru, toplam yeni kaydı da kapsasın. Tek son çıktı seç; kaynak değişmesin. Formüllere hesaplanmış sonuç uydurma.",
    en: "Preserve existing sheets. On a new Sales sheet create a real Excel table SalesData with Item, Qty, Price, Amount. Initial records are A,2,10 and B,3,5; Amount is a calculated quantity × price column. Include a Total-labelled totals row with an Amount sum formula. Sales!F1 must be SUM(SalesData[Amount]), using the column name. Then append C,4,2, retaining calculated formulas and moving the totals row so the total includes the new record. Select one final output, preserve the source and do not fabricate formula results.",
    changes: [
      ...sales,
      {
        kind: "edit_table",
        sheetName: "Sales",
        tableName: "SalesData",
        range: "A1:D5",
      },
      {
        kind: "write_cells",
        sheetName: "Sales",
        startCell: "A4",
        values: [[text("C"), number(4), number(2)]],
        overwrite: true,
      },
    ],
  },
  authoring_lifecycle: {
    tr: "Mevcut sayfaları koru. Sırayla şu yaşam döngüsünü tamamla:\n1. Yeni Sales sayfasında Item, Qty, Price, Amount başlıkları ve A,2,10 ile B,3,5 kayıtları olsun.\n2. SalesData adlı gerçek Excel tablosunda iki kayıt da kalsın. Amount gerçek hesaplanan kolon olsun: kendi satırının Qty ve Price kolon adlarına bağlı miktar × fiyat formülü yeni kayıtlara otomatik yayılsın. Total etiketli toplam satırını iki kaydın ALTINA ekle; hiçbir kaydın üstüne yazma.\n3. F1'e SUM(SalesData[Amount]) formülünü yaz.\n4. Toplam satırını kaldır.\n5. Tabloyu yalnız ilk kayıt kalacak şekilde A1:D2'ye küçült; dışarıda kalan B kaydının değer ve formülünü koru.\n6. Tablo adını Orders, Qty kolonunu Quantity yap.\n7. Tabloyu normal aralığa çevir; görünümü ve formülleri koru. Son dosyada gerçek tablo kalmasın.\nSunucuda hesaplanmış sonuç iddia etme.",
    en: "Preserve existing sheets. Complete this lifecycle in order:\n1. Add Sales with headers Item, Qty, Price, Amount and records A,2,10 and B,3,5.\n2. Keep both records in a real Excel table named SalesData. Amount must be a genuine calculated column using each row's Qty and Price column names, so new records inherit its quantity × price formula automatically. Add a Total-labelled totals row BELOW both records; do not overwrite either record.\n3. Put SUM(SalesData[Amount]) in F1.\n4. Remove the totals row.\n5. Shrink the table to A1:D2, retaining the excluded B record's values and formula.\n6. Rename the table Orders and Qty to Quantity.\n7. Convert it to a normal range, preserving appearance and formulas. No real table remains in the final file.\nDo not claim server calculation.",
    changes: [
      ...sales,
      {
        kind: "edit_table",
        sheetName: "Sales",
        tableName: "SalesData",
        totals: null,
      },
      {
        kind: "edit_table",
        sheetName: "Sales",
        tableName: "SalesData",
        range: "A1:D2",
      },
      {
        kind: "edit_table",
        sheetName: "Sales",
        tableName: "SalesData",
        name: "Orders",
        columns: [{ column: "Qty", name: "Quantity" }],
      },
      { kind: "convert_table", sheetName: "Sales", tableName: "Orders" },
    ],
  },
  authoring_continuation: {
    tr: "Mevcut sayfaları koru. Önce yeni Sales sayfasında SalesData tablosunu oluştur: Item,Qty,Price,Amount; kayıtlar A,2,10; B,3,5; C,4,2. Amount miktar × fiyat formülü, Total etiketli toplam satırı ve F1'de SUM(SalesData[Amount]) olsun. Bu ilk tamamlanmış sürümü sakla. İkinci araç çağrısında ilk sürümden C kaydının Qty değerini 5 yap ve G1'e Later yaz. Üçüncü çağrıda ikinci sürümü değil saklanan ilk sürümü kaynak alıp C kaydının Qty değerini 6 yap. Son seçilen çıktı bu üçüncü dal olsun, G1 boş kalsın. Önceki sürümleri ve biçim/formül/tablo yapısını koru. Sunucuda hesaplandığını iddia etme.",
    en: "Preserve existing sheets. First create Sales with table SalesData: Item,Qty,Price,Amount and A,2,10; B,3,5; C,4,2. Amount is quantity × price; include a Total-labelled totals row and F1 SUM(SalesData[Amount]). Retain this first completed version. In a second tool call use that first version, set C's Qty to 5 and G1 to Later. In a third call branch from the retained FIRST version, not the second, and set C's Qty to 6. Select this third branch as final; G1 must be empty. Keep previous versions and styles/formulas/table intact. Do not claim server calculation.",
    changes: [
      ...sales,
      {
        kind: "edit_table",
        sheetName: "Sales",
        tableName: "SalesData",
        range: "A1:D5",
      },
      {
        kind: "write_cells",
        sheetName: "Sales",
        startCell: "A4",
        values: [[text("C"), number(4), number(2)]],
        overwrite: true,
      },
    ],
  },
  authoring_merge: {
    tr: "Kaynağı ve mevcut sayfaları koru. Yeni Title sayfasında A1 metni Ad, B1 metni Soyad olsun. A1:B1 hücrelerini birleştir. Sol üst dışındaki Soyad içeriğinin silinmesine açıkça izin veriyorum; yalnız Ad kalsın. Birleştirilmiş aralığa sarı arka plan uygula ve yeni çıktı üret.",
    en: "Preserve the source and existing sheets. On a new sheet named Title, put the text Ad in A1 and Soyad in B1. Merge A1:B1. I explicitly authorize discarding the non-anchor Soyad content; retain only Ad. Give the merged range a yellow fill and produce a new output.",
    changes: [
      { kind: "add_sheet", name: "Title" },
      {
        kind: "write_cells",
        sheetName: "Title",
        startCell: "A1",
        values: [[text("Ad"), text("Soyad")]],
      },
      {
        kind: "merge_cells",
        sheetName: "Title",
        range: "A1:B1",
        loss: "discard_non_anchor",
      },
      {
        kind: "format_cells",
        sheetName: "Title",
        range: "A1:B1",
        style: { fill: "FFFF00" },
      },
    ],
  },
  authoring_unsupported: {
    tr: "Kaynak dosyanın Sheet1!J10 hücresine dinamik taşan dizi formülü FILTER(A1:A5,A1:A5>0) ekle. Bu formül türü desteklenmiyorsa alternatif formül veya veri çıktısı üretme; aracı kullanarak desteği kontrol et ve reddi dürüstçe bildir.",
    en: "Write the dynamic spilling array formula FILTER(A1:A5,A1:A5>0) into source.xlsx Sheet1!J10. If this formula class is unsupported, do not produce an alternative formula or data-only output. Check support through the tool and report the refusal honestly.",
    changes: [
      {
        kind: "write_formula",
        sheetName: "Sheet1",
        cell: "J10",
        formula: "FILTER(A1:A5,A1:A5>0)",
      },
    ],
  },
} as const;
